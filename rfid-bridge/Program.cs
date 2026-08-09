// Step 2 (MIFARE Classic 1K detour): the three cards that shipped with this
// reader turned out to be MIFARE Classic 1K, not the NTAG213/215 the
// original plan assumed (confirmed via ATR — see DescribeCardFromAtr).
// Classic needs a per-block authentication step NTAG never would have, and
// works in 16-byte blocks instead of 4-byte pages — everything in the
// "Low-level block read/write" section below exists because of that
// difference. The NDEF encode/decode layer (BuildNdefTextMessage/
// TryParseNdefText) is untouched from the NTAG version: it just wants N
// bytes from somewhere and doesn't care how they got read off the card,
// which is exactly why that split paid off here.
//
// Storage location: sector 1's three data blocks (4, 5, 6) — block 7 is
// that sector's TRAILER block (holds the sector's keys/access bits) and is
// deliberately never touched; writing garbage there can permanently lock
// the sector. Sector 0 is skipped entirely (block 0 is the read-only
// manufacturer block). See WriteBlockWithRetry for the hard guard against
// ever writing a trailer block even if this constant changes later.
//
// Run with: dotnet run                 (normal read/write against a reader)
//           dotnet run -- --selftest   (NDEF encode/decode only, no hardware)

using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using PCSC;
using PCSC.Exceptions;
using PCSC.Monitoring;

const int MifareFirstDataBlock = 4;
const int MifareDataBlockCount = 3; // blocks 4,5,6 = 48 bytes; block 7 (trailer) excluded
const int MifareBlockSize = 16;
const byte MifareKeySlot = 0x00;
const int BridgePort = 8787; // the browser app connects to ws://localhost:8787/
const int WriteWindowSeconds = 25; // how long an armed write waits for a tap before auto-clearing

// No hardware involved in this path — pure byte-level round-trip check of
// the encode/decode logic, run with: dotnet run -- --selftest
if (args.Contains("--selftest"))
{
    RunSelfTest();
    return;
}

using var context = ContextFactory.Instance.Establish(SCardScope.System);

Console.WriteLine("Watching for an NFC reader... plug in the ACR122U now if it isn't already.");

string[] readers = GetReadersSafely(context);
var waitAttempts = 0;
while (readers.Length == 0)
{
    waitAttempts++;
    if (waitAttempts == 8)
    {
        Console.WriteLine();
        Console.WriteLine("Still no reader detected after 8 seconds. A few things to check:");
        Console.WriteLine("  - Is the ACR122U actually plugged into a USB port (try a different port/cable)?");
        Console.WriteLine("  - Open services.msc and confirm \"Smart Card\" (SCardSvr) is running.");
        Console.WriteLine("  - Does the reader show up in Device Manager, under \"Smart card readers\"?");
        Console.WriteLine("This program will keep watching — no need to restart it once you fix something.");
    }
    await Task.Delay(1000);
    readers = GetReadersSafely(context);
}

foreach (var name in readers) Console.WriteLine($"Reader connected: {name}");
Console.WriteLine();

// Set by an incoming {"type":"write","username":"..."} message from the
// browser, consumed by the very next card tap (see CardInserted below).
// No console prompt anymore — the technician does everything from the app
// now; this window is just a log they never need to touch.
string? pendingWrite = null;

// Guards against a stale arm getting consumed by some unrelated later tap
// (e.g. someone testing the reader minutes after a registration that never
// got carded). Cancelled whenever pendingWrite is consumed or re-armed, so
// only one expiry timer is ever actually in flight.
CancellationTokenSource? pendingWriteExpiry = null;

// Debug-only: erases whatever card is tapped next, no username involved.
// This is the one path that deliberately bypasses the "never overwrite an
// already-programmed card" guard in CardInserted below — the whole point is
// to reclaim one of a small number of physical test cards for reuse, not to
// protect it. Checked before pendingWrite so an armed wipe always wins if
// somehow both were armed at once.
bool pendingWipe = false;
CancellationTokenSource? pendingWipeExpiry = null;

// ---------------------------------------------------------------------
// WebSocket bridge — the one piece that actually connects this program to
// the Recycle Heroes browser app. Two message types out:
//   {"type":"card","username":"..."}                       — a read, on every tap while idle
//   {"type":"write-armed","username":"...","expiresInSeconds":int}  — ack that a write command was received
//   {"type":"write-result","success":bool,"username":...,"error":string|null}
//   {"type":"write-expired","username":"..."}               — window closed with no tap
//   {"type":"wipe-armed","expiresInSeconds":int}             — ack that a wipe command was received
//   {"type":"wipe-result","success":bool,"error":string|null}
//   {"type":"wipe-expired"}                                  — window closed with no tap
//   {"type":"wipe-cancelled"}                                — ack that an armed wipe was cancelled
// Three message types in:
//   {"type":"write","username":"..."}                       — "write this to the next card tapped"
//   {"type":"wipe"}                                          — "erase the next card tapped" (debug only)
//   {"type":"cancel-wipe"}                                   — "never mind" (debug only)
// Nothing here validates a username or decides whether it's a good idea —
// that's entirely the app's job, same as if a card were just a keyboard.
// Bound to localhost only; this never listens on the network.
// ---------------------------------------------------------------------

var connectedSockets = new List<WebSocket>();
var socketsLock = new object();

var httpListener = new HttpListener();
httpListener.Prefixes.Add($"http://localhost:{BridgePort}/");
try
{
    httpListener.Start();
    Console.WriteLine($"Bridge listening on ws://localhost:{BridgePort}/ — point the app at this.");
}
catch (Exception ex)
{
    Console.WriteLine($"Could not start the WebSocket bridge on port {BridgePort}: {ex.Message}");
    Console.WriteLine("Card reads will still print here, but won't reach the browser app.");
}

async Task BroadcastAsync(object message)
{
    var json = JsonSerializer.Serialize(message);
    var bytes = Encoding.UTF8.GetBytes(json);
    List<WebSocket> snapshot;
    lock (socketsLock) snapshot = new List<WebSocket>(connectedSockets);

    foreach (var socket in snapshot)
    {
        if (socket.State != WebSocketState.Open) continue;
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch
        {
            // Dropped mid-send — MonitorSocketAsync's own loop will clean it up.
        }
    }
}

async Task HandleIncomingMessageAsync(string json)
{
    JsonDocument doc;
    try
    {
        doc = JsonDocument.Parse(json);
    }
    catch (JsonException)
    {
        return; // malformed message from the browser — never let this crash the bridge
    }

    using (doc)
    {
        var root = doc.RootElement;
        var type = root.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;

        if (type == "write")
        {
            if (!root.TryGetProperty("username", out var usernameEl)) return;
            var username = usernameEl.GetString();
            if (string.IsNullOrWhiteSpace(username)) return;

            pendingWrite = username;
            Console.WriteLine($"Armed by the app: will write \"{username}\" to the next card tapped (expires in {WriteWindowSeconds}s).");
            await BroadcastAsync(new { type = "write-armed", username, expiresInSeconds = WriteWindowSeconds });

            pendingWriteExpiry?.Cancel();
            var expiryCts = new CancellationTokenSource();
            pendingWriteExpiry = expiryCts;
            _ = ExpireWriteAfterDelayAsync(username, expiryCts);
        }
        else if (type == "wipe")
        {
            pendingWipe = true;
            Console.WriteLine($"Armed by the app: will WIPE the next card tapped, whatever is on it (expires in {WriteWindowSeconds}s).");
            await BroadcastAsync(new { type = "wipe-armed", expiresInSeconds = WriteWindowSeconds });

            pendingWipeExpiry?.Cancel();
            var wipeExpiryCts = new CancellationTokenSource();
            pendingWipeExpiry = wipeExpiryCts;
            _ = ExpireWipeAfterDelayAsync(wipeExpiryCts);
        }
        else if (type == "cancel-wipe")
        {
            // Debug-tool-only cancel — the app waits for this ack rather than
            // just clearing its own UI optimistically, so there's no window
            // where the browser thinks it's safe but the bridge is still
            // armed and would wipe the next card tapped regardless.
            pendingWipe = false;
            pendingWipeExpiry?.Cancel();
            pendingWipeExpiry = null;
            Console.WriteLine("Wipe cancelled from the app.");
            await BroadcastAsync(new { type = "wipe-cancelled" });
        }
    }
}

// Runs alongside the armed write; if nothing consumes pendingWrite before
// the window closes, clears it so a later, unrelated tap can't accidentally
// get written with stale data. Cancelled (not awaited to completion) by
// whichever happens first: a tap consuming pendingWrite, or a newer write
// re-arming and superseding this one.
async Task ExpireWriteAfterDelayAsync(string username, CancellationTokenSource cts)
{
    try
    {
        await Task.Delay(TimeSpan.FromSeconds(WriteWindowSeconds), cts.Token);
    }
    catch (TaskCanceledException)
    {
        return;
    }

    if (pendingWrite == username)
    {
        pendingWrite = null;
        Console.WriteLine($"Write window for \"{username}\" expired — no card was tapped in time.");
        await BroadcastAsync(new { type = "write-expired", username });
    }
}

// Same idea as ExpireWriteAfterDelayAsync, for an armed wipe.
async Task ExpireWipeAfterDelayAsync(CancellationTokenSource cts)
{
    try
    {
        await Task.Delay(TimeSpan.FromSeconds(WriteWindowSeconds), cts.Token);
    }
    catch (TaskCanceledException)
    {
        return;
    }

    if (pendingWipe)
    {
        pendingWipe = false;
        Console.WriteLine("Wipe window expired — no card was tapped in time.");
        await BroadcastAsync(new { type = "wipe-expired" });
    }
}

async Task MonitorSocketAsync(WebSocket socket)
{
    var buffer = new byte[4096];
    try
    {
        while (socket.State == WebSocketState.Open)
        {
            using var stream = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    // Completing the close handshake (not just returning)
                    // matters: without sending our own close frame back,
                    // the TCP connection sits in CLOSE_WAIT until the OS
                    // eventually times it out rather than closing right
                    // away. Found this the hard way — a long dev session
                    // with lots of browser reconnects left 40+ CLOSE_WAIT
                    // sockets stacked up on the bridge.
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                    return;
                }
                stream.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            await HandleIncomingMessageAsync(Encoding.UTF8.GetString(stream.ToArray()));
        }
    }
    catch
    {
        // Connection dropped — falls through to cleanup below either way.
    }
    finally
    {
        lock (socketsLock) connectedSockets.Remove(socket);
        Console.WriteLine("Browser disconnected from the bridge.");
    }
}

async Task AcceptConnectionsLoopAsync()
{
    while (httpListener.IsListening)
    {
        HttpListenerContext httpContext;
        try
        {
            httpContext = await httpListener.GetContextAsync();
        }
        catch (Exception)
        {
            return; // listener was stopped
        }

        if (!httpContext.Request.IsWebSocketRequest)
        {
            httpContext.Response.StatusCode = 400;
            httpContext.Response.Close();
            continue;
        }

        // This loop is fire-and-forget from Main (`_ = AcceptConnectionsLoopAsync()`),
        // so an unhandled exception here wouldn't crash the bridge — it would
        // just silently end the `while` loop, meaning the console keeps
        // running and card reads keep working, but no browser could ever
        // connect again without a manual restart. A failed handshake
        // (malformed request, connection dropped mid-upgrade) shouldn't be
        // able to take down every future connection like that.
        try
        {
            var wsContext = await httpContext.AcceptWebSocketAsync(null);
            lock (socketsLock) connectedSockets.Add(wsContext.WebSocket);
            Console.WriteLine("Browser connected to the bridge.");
            _ = MonitorSocketAsync(wsContext.WebSocket);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WebSocket handshake failed: {ex.Message}");
        }
    }
}

if (httpListener.IsListening)
{
    _ = AcceptConnectionsLoopAsync();
}

Console.WriteLine("Tap a card against the reader...");

using var monitor = MonitorFactory.Instance.Create(SCardScope.System);

monitor.CardInserted += async (sender, args) =>
{
    var atr = BitConverter.ToString(args.Atr ?? Array.Empty<byte>()).Replace("-", " ");
    Console.WriteLine($"  ATR: {atr}{DescribeCardFromAtr(args.Atr)}");
    try
    {
        var reader = ConnectWithRetry(context, args.ReaderName);
        try
        {
            if (!LoadDefaultKeyWithRetry(reader))
            {
                Console.WriteLine("  Could not load the authentication key into the reader — aborting this tap.");
                return;
            }

            if (pendingWipe)
            {
                // Debug-only path, checked first and deliberately skips the
                // blank-card guard below — the whole point of arming a wipe
                // is to erase a card no matter what's currently on it, so a
                // small pool of physical test cards can be reused instead of
                // permanently "used up" one at a time.
                pendingWipe = false;
                pendingWipeExpiry?.Cancel();
                pendingWipeExpiry = null;
                // Once pendingWipe is consumed above, the app is guaranteed a
                // wipe-result — otherwise it's stuck showing "armed" forever
                // with no way to escape (this UI has no cancel button). A
                // card pulled away mid-write throws instead of returning
                // false (Transmit itself throws, not just WriteBlockWithRetry's
                // retry loop), so this has to be a try/catch, not a null check.
                bool wipeSuccess;
                string? wipeError;
                try
                {
                    (wipeSuccess, wipeError) = WipeAndVerify(reader);
                }
                catch (Exception ex)
                {
                    wipeSuccess = false;
                    wipeError = $"Card was removed or a communication error occurred mid-wipe: {ex.Message}";
                    Console.WriteLine($"  {wipeError}");
                }
                await BroadcastAsync(new { type = "wipe-result", success = wipeSuccess, error = wipeError });
            }
            else if (!string.IsNullOrEmpty(pendingWrite))
            {
                // Never overwrite a card that already has someone's username on
                // it. This is the actual fix for "an armed write catches the
                // wrong card" — e.g. a second, unrelated visitor taps their own
                // already-programmed card while a write is still armed for
                // someone else. Without this check that tap would silently
                // clobber their card with the wrong username. With it, an
                // already-programmed card just falls through to a normal
                // check-in for whoever it actually belongs to, and the pending
                // write stays armed, still waiting for an actual blank card.
                var existingText = ReadAndPrint(reader);
                if (!string.IsNullOrEmpty(existingText))
                {
                    Console.WriteLine($"  This card already belongs to \"{existingText}\" — treating as a check-in, not overwriting. Write for \"{pendingWrite}\" is still armed.");
                    await BroadcastAsync(new { type = "card", username = existingText });
                }
                else
                {
                    var textToWrite = pendingWrite;
                    pendingWrite = null; // only ever consumed once, regardless of outcome
                    pendingWriteExpiry?.Cancel();
                    pendingWriteExpiry = null;
                    // Same reasoning as the wipe path above — pendingWrite is
                    // already consumed by this point, so the app absolutely
                    // needs a write-result out of this, even if the card gets
                    // pulled away mid-write and Transmit throws.
                    bool success;
                    string? error;
                    try
                    {
                        (success, error) = WriteAndVerify(reader, textToWrite);
                    }
                    catch (Exception ex)
                    {
                        success = false;
                        error = $"Card was removed or a communication error occurred mid-write: {ex.Message}";
                        Console.WriteLine($"  {error}");
                    }
                    await BroadcastAsync(new { type = "write-result", success, username = textToWrite, error });
                }
            }
            else
            {
                var text = ReadAndPrint(reader);
                if (text != null) await BroadcastAsync(new { type = "card", username = text });
            }
        }
        finally
        {
            reader.Disconnect(SCardReaderDisposition.Leave);
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"  Card detected, but the operation failed: {ex.Message}");
    }
};

monitor.CardRemoved += (sender, args) =>
{
    Console.WriteLine("  Card removed.");
};

monitor.MonitorException += (sender, exception) =>
{
    Console.WriteLine($"  Monitor error: {exception.Message}");
};

monitor.Start(readers);

Console.WriteLine("Press Ctrl+C to stop.");
await Task.Delay(Timeout.Infinite);

// ---------------------------------------------------------------------
// ATR card-type identification — straight from the ACR122U API reference
// (Table 2: ATR format for ISO 14443 Part 3 PICCs). For the standard
// 20-byte MIFARE-family ATR shape, bytes 13–14 are the "card name":
//   00 01 = MIFARE Classic 1K      00 02 = MIFARE Classic 4K
//   00 03 = MIFARE Ultralight      00 26 = MIFARE Mini
//   F0 04 = Topaz/Jewel            F0 11 = FeliCa 212K   F0 12 = FeliCa 424K
static string DescribeCardFromAtr(byte[]? atr)
{
    if (atr == null || atr.Length < 15) return "";
    var name = (atr[13], atr[14]);
    var label = name switch
    {
        (0x00, 0x01) => "MIFARE Classic 1K",
        (0x00, 0x02) => "MIFARE Classic 4K",
        (0x00, 0x03) => "MIFARE Ultralight (NTAG-compatible, no auth needed)",
        (0x00, 0x26) => "MIFARE Mini",
        (0xF0, 0x04) => "Topaz/Jewel",
        (0xF0, 0x11) => "FeliCa 212K",
        (0xF0, 0x12) => "FeliCa 424K",
        _ => null,
    };
    return label != null ? $"  -->  {label}" : "  -->  (unrecognized card name bytes)";
}

// ---------------------------------------------------------------------
// Card operations
// ---------------------------------------------------------------------

// Returns the decoded text so the caller can broadcast it over the bridge —
// null for anything that isn't a successful, readable card (the caller
// treats that as "nothing to send," not an error to propagate further).
static string? ReadAndPrint(ICardReader reader)
{
    var blockData = ReadMifareDataWithRetry(reader);
    if (blockData == null)
    {
        Console.WriteLine("  Card detected, but couldn't read its memory (see raw errors above, if any).");
        return null;
    }

    var text = TryParseNdefText(blockData);
    Console.WriteLine(text != null
        ? $"  Card detected — stored text: \"{text}\""
        : $"  Card detected — no readable NDEF text record found (raw: {BitConverter.ToString(blockData).Replace("-", " ")})");
    return text;
}

// Returns (success, error) rather than just printing — the caller
// broadcasts this to the browser so the UI can show real success/failure
// instead of assuming a write worked just because a tap happened.
static (bool Success, string? Error) WriteAndVerify(ICardReader reader, string text)
{
    var message = BuildNdefTextMessage(text);
    var totalBytes = MifareDataBlockCount * MifareBlockSize;
    if (message.Length > totalBytes)
    {
        var tooLongError = $"\"{text}\" is too long to fit in the {totalBytes} bytes available.";
        Console.WriteLine($"  {tooLongError} Not writing anything.");
        return (false, tooLongError);
    }
    var padded = new byte[totalBytes];
    Array.Copy(message, padded, message.Length); // trailing bytes stay zero — fine, the terminator TLV already ends the message

    for (var i = 0; i < MifareDataBlockCount; i++)
    {
        var block = MifareFirstDataBlock + i;
        var blockBytes = padded[(i * MifareBlockSize)..(i * MifareBlockSize + MifareBlockSize)];
        if (!WriteBlockWithRetry(reader, block, blockBytes))
        {
            var writeError = $"Write failed at block {block} — check the card is a factory-default MIFARE Classic 1K, not personalized/locked.";
            Console.WriteLine($"  {writeError}");
            return (false, writeError);
        }
    }

    Console.WriteLine($"  Wrote \"{text}\" ({MifareDataBlockCount} block(s)). Reading it back to confirm...");
    var readBack = ReadMifareDataWithRetry(reader);
    var readBackText = readBack != null ? TryParseNdefText(readBack) : null;

    if (readBackText == text)
    {
        Console.WriteLine("  Confirmed — read-back matches exactly.");
        return (true, null);
    }

    var mismatchError = $"Read back \"{readBackText ?? "(nothing readable)"}\", expected \"{text}\".";
    Console.WriteLine($"  MISMATCH — {mismatchError}");
    return (false, mismatchError);
}

// Debug-only counterpart to WriteAndVerify — zeroes the data blocks instead
// of writing a message, so a physical test card can be reclaimed and reused
// rather than staying permanently "occupied" by whatever it was last
// programmed with. Called from the pendingWipe branch above, which is the
// only caller allowed to skip the already-programmed-card guard.
static (bool Success, string? Error) WipeAndVerify(ICardReader reader)
{
    var zero = new byte[MifareBlockSize];

    for (var i = 0; i < MifareDataBlockCount; i++)
    {
        var block = MifareFirstDataBlock + i;
        if (!WriteBlockWithRetry(reader, block, zero))
        {
            var writeError = $"Wipe failed at block {block} — check the card is a factory-default MIFARE Classic 1K, not personalized/locked.";
            Console.WriteLine($"  {writeError}");
            return (false, writeError);
        }
    }

    Console.WriteLine("  Wiped card. Reading it back to confirm it's blank...");
    var readBack = ReadMifareDataWithRetry(reader);
    var readBackText = readBack != null ? TryParseNdefText(readBack) : null;

    if (readBackText == null)
    {
        Console.WriteLine("  Confirmed — card reads as blank.");
        return (true, null);
    }

    var mismatchError = $"Card still reads \"{readBackText}\" after wiping.";
    Console.WriteLine($"  MISMATCH — {mismatchError}");
    return (false, mismatchError);
}

// ---------------------------------------------------------------------
// NDEF encode/decode — short-record Text ('T') wrapped in a type-3 TLV,
// terminated with a type-FE TLV. This is the same shape any standard NFC
// tool (including a phone's NFC Tools app) will read as plain text.
// Unchanged from the NTAG version — it operates on a plain byte array and
// has no idea whether that came from pages or blocks.
// ---------------------------------------------------------------------

static byte[] BuildNdefTextMessage(string text)
{
    var langCode = Encoding.ASCII.GetBytes("en");
    var textBytes = Encoding.UTF8.GetBytes(text);

    var payload = new byte[1 + langCode.Length + textBytes.Length];
    payload[0] = (byte)langCode.Length; // top bit 0 = UTF-8; low 6 bits = language code length
    Array.Copy(langCode, 0, payload, 1, langCode.Length);
    Array.Copy(textBytes, 0, payload, 1 + langCode.Length, textBytes.Length);

    var record = new byte[4 + payload.Length];
    record[0] = 0xD1; // MB=1, ME=1, CF=0, SR=1 (short record), IL=0, TNF=001 (Well Known)
    record[1] = 0x01; // type length
    record[2] = (byte)payload.Length; // payload length (fits in one byte — SR=1)
    record[3] = (byte)'T';
    Array.Copy(payload, 0, record, 4, payload.Length);

    var tlv = new byte[2 + record.Length + 1];
    tlv[0] = 0x03; // NDEF Message TLV
    tlv[1] = (byte)record.Length;
    Array.Copy(record, 0, tlv, 2, record.Length);
    tlv[^1] = 0xFE; // Terminator TLV
    return tlv;
}

static string? TryParseNdefText(byte[] data)
{
    var i = 0;
    while (i < data.Length)
    {
        var tlvType = data[i];
        if (tlvType == 0x00) { i++; continue; } // NULL TLV — padding, skip one byte
        if (tlvType == 0xFE) return null; // terminator reached, no NDEF message TLV found

        if (i + 1 >= data.Length) return null;
        var tlvLen = data[i + 1];
        var recordStart = i + 2;
        if (recordStart + tlvLen > data.Length) return null; // didn't read enough to cover it

        if (tlvType != 0x03) { i = recordStart + tlvLen; continue; } // some other TLV, skip past it

        var record = data[recordStart..(recordStart + tlvLen)];
        if (record.Length < 4) return null;

        var header = record[0];
        var isShortRecord = (header & 0x10) != 0;
        var tnf = header & 0x07;
        if (!isShortRecord || tnf != 0x01) return null; // only handling the short well-known-type case we write ourselves

        var typeLen = record[1];
        var payloadLen = record[2];
        var typeStart = 3;
        if (typeLen != 1 || record[typeStart] != (byte)'T') return null;

        var payloadStart = typeStart + typeLen;
        if (payloadStart + payloadLen > record.Length) return null;
        var payload = record[payloadStart..(payloadStart + payloadLen)];
        if (payload.Length < 1) return null;

        var langLen = payload[0] & 0x3F;
        var textStart = 1 + langLen;
        if (textStart > payload.Length) return null;
        return Encoding.UTF8.GetString(payload[textStart..]);
    }
    return null;
}

// ---------------------------------------------------------------------
// Low-level block read/write for MIFARE Classic 1K, via the ACR122U's
// T=CL emulation commands (API reference, section 5.0). Every block
// access needs the sector authenticated first with the key already
// loaded into the reader by LoadDefaultKeyWithRetry — done once per tap,
// re-done per block here for simplicity/robustness rather than relying on
// "same sector, no need to re-auth" (cheap enough not to matter, and one
// less thing that can be subtly wrong).
// ---------------------------------------------------------------------

// Factory-default key for an unpersonalized MIFARE Classic card. Loaded
// into the reader's volatile key slot 0 once per tap (cleared when the
// card/reader disconnects), per API reference section 5.1.
static bool LoadDefaultKeyWithRetry(ICardReader reader)
{
    byte[] apdu = { 0xFF, 0x82, 0x00, MifareKeySlot, 0x06, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    byte[] buffer = new byte[258];
    const int maxAttempts = 5;

    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        var received = reader.Transmit(apdu, buffer);
        if (received >= 2 && buffer[received - 2] == 0x90 && buffer[received - 1] == 0x00) return true;
        if (attempt < maxAttempts) Thread.Sleep(150);
    }
    return false;
}

// API reference section 5.2 (PC/SC V2.07 format) — Key Type A (0x60)
// against the key just loaded into slot 0.
static bool AuthenticateBlockWithRetry(ICardReader reader, int block)
{
    byte[] apdu = { 0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, (byte)block, 0x60, MifareKeySlot };
    byte[] buffer = new byte[258];
    const int maxAttempts = 5;

    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        var received = reader.Transmit(apdu, buffer);
        if (received >= 2 && buffer[received - 2] == 0x90 && buffer[received - 1] == 0x00) return true;
        if (attempt < maxAttempts) Thread.Sleep(150);
    }
    return false;
}

static byte[]? ReadMifareDataWithRetry(ICardReader reader)
{
    var result = new byte[MifareDataBlockCount * MifareBlockSize];
    for (var i = 0; i < MifareDataBlockCount; i++)
    {
        var block = MifareFirstDataBlock + i;
        if (!AuthenticateBlockWithRetry(reader, block))
        {
            Console.WriteLine($"    (authentication failed for block {block})");
            return null;
        }
        var blockData = ReadBlockWithRetry(reader, block);
        if (blockData == null) return null;
        Array.Copy(blockData, 0, result, i * MifareBlockSize, MifareBlockSize);
    }
    return result;
}

static byte[]? ReadBlockWithRetry(ICardReader reader, int block)
{
    byte[] apdu = { 0xFF, 0xB0, 0x00, (byte)block, (byte)MifareBlockSize };
    byte[] buffer = new byte[258];
    const int maxAttempts = 5;

    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        var received = reader.Transmit(apdu, buffer);
        var raw = BitConverter.ToString(buffer[..received]).Replace("-", " ");
        if (received >= MifareBlockSize + 2 && buffer[received - 2] == 0x90 && buffer[received - 1] == 0x00)
        {
            return buffer[..(received - 2)];
        }
        if (attempt == maxAttempts)
        {
            Console.WriteLine($"    (read block {block} failed after {maxAttempts} attempts — last response: {raw})");
        }
        else
        {
            Thread.Sleep(150);
        }
    }
    return null;
}

static bool WriteBlockWithRetry(ICardReader reader, int block, byte[] sixteenBytes)
{
    // Hard guard, independent of the caller: every 4th block (3, 7, 11, ...)
    // is a sector TRAILER — it holds that sector's keys and access bits, not
    // data. Writing to it can permanently lock the sector. This must never
    // fire given MifareFirstDataBlock/MifareDataBlockCount above, but it's
    // cheap insurance against that constant ever changing carelessly.
    if ((block + 1) % 4 == 0)
    {
        throw new InvalidOperationException($"Refusing to write block {block} — it's a sector trailer block, not data.");
    }
    if (!AuthenticateBlockWithRetry(reader, block))
    {
        Console.WriteLine($"    (authentication failed for block {block})");
        return false;
    }

    byte[] apdu = new byte[5 + MifareBlockSize];
    apdu[0] = 0xFF; apdu[1] = 0xD6; apdu[2] = 0x00; apdu[3] = (byte)block; apdu[4] = (byte)MifareBlockSize;
    Array.Copy(sixteenBytes, 0, apdu, 5, MifareBlockSize);
    byte[] buffer = new byte[258];
    const int maxAttempts = 5;

    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        var received = reader.Transmit(apdu, buffer);
        var raw = BitConverter.ToString(buffer[..received]).Replace("-", " ");
        if (received >= 2 && buffer[received - 2] == 0x90 && buffer[received - 1] == 0x00)
        {
            return true;
        }
        if (attempt == maxAttempts)
        {
            Console.WriteLine($"    (write block {block} failed after {maxAttempts} attempts — last response: {raw})");
        }
        else
        {
            Thread.Sleep(150);
        }
    }
    return false;
}

// ---------------------------------------------------------------------
// Connection + reader discovery
// ---------------------------------------------------------------------

static ICardReader ConnectWithRetry(ISCardContext context, string readerName)
{
    // The monitor's own background polling and this connect attempt can
    // momentarily collide right at the instant a card is detected — a
    // transient "reader busy" is normal here, not a real failure.
    const int maxAttempts = 4;
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            return context.ConnectReader(readerName, SCardShareMode.Shared, SCardProtocol.Any);
        }
        catch (Exception ex) when ((ex is ReaderUnavailableException || ex is SharingViolationException) && attempt < maxAttempts)
        {
            Thread.Sleep(150);
        }
    }
}

static string[] GetReadersSafely(ISCardContext context)
{
    try
    {
        return context.GetReaders();
    }
    catch (NoReadersAvailableException)
    {
        return Array.Empty<string>();
    }
    catch (NoServiceException)
    {
        return Array.Empty<string>();
    }
}

// ---------------------------------------------------------------------
// Self-test — no hardware involved. Simulates exactly what a real card
// round trip does: build the message, zero-pad it out to the full
// available space (the same padding WriteAndVerify would leave on the
// card), then parse it back. Unaffected by the MIFARE Classic detour —
// this layer never knew whether bytes came from pages or blocks.
// ---------------------------------------------------------------------

static void RunSelfTest()
{
    var cases = new[]
    {
        "abc12",           // minimum username length (5)
        "hero_bee1",       // typical
        "UPPER_lower-99",  // mixed case, underscore, hyphen — the full allowed character set
        "aaaaaaaaaaaaaaa", // maximum username length (15), all one character
        "x1234",           // starts with a letter, mostly digits
    };

    var totalBytes = MifareDataBlockCount * MifareBlockSize;
    var passed = 0;
    foreach (var text in cases)
    {
        var simulated = SimulateCardRoundTrip(text, totalBytes);
        var decoded = TryParseNdefText(simulated);
        var ok = decoded == text;
        Console.WriteLine($"[{(ok ? "PASS" : "FAIL")}] \"{text}\" -> decoded \"{decoded ?? "(null)"}\"");
        if (ok) passed++;
    }

    // A blank/never-written card is all zero bytes — should decode to
    // "nothing found", not throw or return garbage.
    var blank = new byte[totalBytes];
    var blankResult = TryParseNdefText(blank);
    var blankOk = blankResult == null;
    Console.WriteLine($"[{(blankOk ? "PASS" : "FAIL")}] blank card -> decoded \"{blankResult ?? "(null)"}\"");
    if (blankOk) passed++;

    // A read that got cut off mid-message should fail gracefully, not
    // throw or return truncated garbage as if it were correct.
    var full = SimulateCardRoundTrip("this_is_fine", totalBytes);
    var truncated = full[..8]; // only 8 of the ~20+ bytes the message actually needs
    var truncatedResult = TryParseNdefText(truncated);
    var truncatedOk = truncatedResult == null;
    Console.WriteLine($"[{(truncatedOk ? "PASS" : "FAIL")}] truncated read -> decoded \"{truncatedResult ?? "(null)"}\"");
    if (truncatedOk) passed++;

    var total = cases.Length + 2;
    Console.WriteLine();
    Console.WriteLine($"{passed}/{total} passed.");
}

static byte[] SimulateCardRoundTrip(string text, int totalBytes)
{
    var message = BuildNdefTextMessage(text);
    var simulatedRead = new byte[totalBytes];
    Array.Copy(message, simulatedRead, Math.Min(message.Length, simulatedRead.Length));
    return simulatedRead;
}
