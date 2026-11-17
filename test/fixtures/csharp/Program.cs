using System.Runtime.CompilerServices;

internal static class Program
{
    private static int evaluations;
    // Explicit evaluation of RiskyValue changes state. Snapshots must not read it.
    public static int RiskyValue => ++evaluations;
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Add(int left, int right)
    {
        int sum = left + right; // BREAKPOINT: known locals left=20, right=22
        return sum;
    }
    private static void Main()
    {
        Console.WriteLine("Fixture PID=" + Environment.ProcessId);
        for (int i = 0; i < 120; ++i)
        {
            Console.WriteLine(Add(20, 22));
            Thread.Sleep(500);
        }
    }
}
