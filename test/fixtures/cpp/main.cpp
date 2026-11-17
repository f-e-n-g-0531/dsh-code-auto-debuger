#include <chrono>
#include <iostream>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#endif

__declspec(noinline) int Add(int left, int right)
{
    int sum = left + right; // BREAKPOINT: known locals left=20, right=22
    return sum;
}
int main()
{
#ifdef _WIN32
    std::cout << "Fixture PID=" << GetCurrentProcessId() << std::endl;
#endif
    for (int i = 0; i < 120; ++i)
    {
        std::cout << Add(20, 22) << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
}
