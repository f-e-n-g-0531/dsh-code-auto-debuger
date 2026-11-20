#include <chrono>
#include <cstdint>
#include <windows.h>

__declspec(noinline) std::uint64_t ProfileFixtureHotFunction(std::uint64_t seed) {
    volatile std::uint64_t value = seed;
    for (int i = 0; i < 400000; ++i)
        value = value * 6364136223846793005ULL + 1;
    return value;
}

int main() {
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    auto end = std::chrono::steady_clock::now() + std::chrono::seconds(45);
    std::uint64_t x = 1;
    do {
        x = ProfileFixtureHotFunction(x);
        Sleep(1);
    } while (std::chrono::steady_clock::now() < end);
    return x == 0 ? 1 : 0;
}
