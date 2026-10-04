#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <iostream>
#include <string>

int main() {
    std::string line;
    while (std::getline(std::cin, line)) {
        try {
            const auto case_data = scryer::parse_case(scryer::parse_document(line));
            std::cout << "OK\t" << case_data.case_id << '\t';
            for (std::size_t i = 0; i < case_data.events.size(); ++i) {
                if (i != 0) {
                    std::cout << ',';
                }
                std::cout << case_data.events[i].event_id;
            }
            std::cout << '\n';
        } catch (const scryer::ScryerError& error) {
            std::cout << "ERR\t" << error.code() << '\n';
        }
    }
}
