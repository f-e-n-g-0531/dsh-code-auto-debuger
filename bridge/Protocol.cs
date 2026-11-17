using System.Text;
using System.Text.Json;

namespace Dsh.VisualStudio.Bridge;

internal sealed class BridgeError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed record Request(JsonElement Id, string Method, JsonElement Parameters);

internal static class Protocol
{
    public const int MaxLineBytes = 65536;
    public static Request Parse(string line)
    {
        using var doc = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
        var root = doc.RootElement;
        Fields(root, "protocol", "id", "method", "params");
        if (!root.TryGetProperty("protocol", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out int v) || v != 1)
            throw new BridgeError("INVALID_REQUEST", "protocol must be 1");
        if (!root.TryGetProperty("id", out var id) || !(id.ValueKind == JsonValueKind.String || id.ValueKind == JsonValueKind.Number))
            throw new BridgeError("INVALID_REQUEST", "id must be a string or number");
        if (id.GetRawText().Length > 256) throw new BridgeError("INVALID_REQUEST", "id exceeds 256 characters");
        var method = Text(root, "method", 64);
        JsonElement parameters = root.TryGetProperty("params", out var p) ? p.Clone() : JsonSerializer.SerializeToElement(new { });
        if (parameters.ValueKind != JsonValueKind.Object) throw new BridgeError("INVALID_REQUEST", "params must be an object");
        return new Request(id.Clone(), method, parameters);
    }

    public static void Fields(JsonElement obj, params string[] names)
    {
        if (obj.ValueKind != JsonValueKind.Object) throw new BridgeError("INVALID_REQUEST", "Expected object");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in obj.EnumerateObject())
            if (!names.Contains(p.Name, StringComparer.Ordinal) || !seen.Add(p.Name))
                throw new BridgeError("INVALID_REQUEST", "Unknown or duplicate field: " + p.Name);
    }

    public static string Text(JsonElement obj, string name, int max = 4096)
    {
        if (!obj.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(p.GetString()) || p.GetString()!.Length > max)
            throw new BridgeError("INVALID_REQUEST", name + " must be a nonempty bounded string");
        return p.GetString()!;
    }

    public static int PositiveInt(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.Number || !p.TryGetInt32(out int n) || n <= 0)
            throw new BridgeError("INVALID_REQUEST", name + " must be a positive integer");
        return n;
    }

    // Bounded byte reader: never allocates an unbounded ReadLine string. Drain one
    // oversized record so subsequent records remain framed correctly.
    public static IEnumerable<(string? Line, string? Error)> ReadLines(Stream stream)
    {
        var buffer = new byte[MaxLineBytes];
        int used = 0;
        bool overflow = false;
        var utf8 = new UTF8Encoding(false, true);
        while (true)
        {
            int next = stream.ReadByte();
            if (next == -1 && used == 0 && !overflow) yield break;
            if (next == 10 || next == -1)
            {
                string? text = null, error = null;
                if (overflow) error = "Request exceeds 65536 UTF-8 bytes";
                else
                {
                    try { text = utf8.GetString(buffer, 0, used).TrimEnd('\r'); }
                    catch (DecoderFallbackException) { error = "Request is not valid UTF-8"; }
                }
                yield return (text, error);
                used = 0; overflow = false;
                if (next == -1) yield break;
            }
            else if (used < buffer.Length) buffer[used++] = (byte)next;
            else overflow = true;
        }
    }
}
