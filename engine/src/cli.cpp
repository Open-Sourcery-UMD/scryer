#include "scryer/api.hpp"

#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <new>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

namespace {

constexpr std::size_t kMaxDocumentBytes = 20 * 1024 * 1024;

struct Options {
    std::optional<std::string> input;
    std::optional<std::string> output;
    bool demo = false;
};

Options parse_options(int argc, char** argv) {
    Options result;
    for (int index = 1; index < argc; ++index) {
        const std::string_view option(argv[index]);
        if (option == "demo") {
            if (argc != 2) {
                throw scryer::ScryerError("INVALID_CLI_USAGE");
            }
            result.demo = true;
        } else if (option == "--input" || option == "--output") {
            if (++index >= argc || argv[index][0] == '\0') {
                throw scryer::ScryerError("INVALID_CLI_USAGE");
            }
            auto& slot = option == "--input" ? result.input : result.output;
            if (slot) {
                throw scryer::ScryerError("INVALID_CLI_USAGE");
            }
            slot = argv[index];
        } else {
            throw scryer::ScryerError("INVALID_CLI_USAGE");
        }
    }
    return result;
}

std::string read_document(const std::optional<std::string>& input) {
    int descriptor = STDIN_FILENO;
    if (input) {
        descriptor = ::open(input->c_str(), O_RDONLY);
        if (descriptor < 0) {
            throw scryer::ScryerError("IO_ERROR");
        }
    }
    std::string document;
    char buffer[65536];
    try {
        while (true) {
            const auto remaining = kMaxDocumentBytes + 1 - document.size();
            const auto requested = std::min(remaining, sizeof(buffer));
            const auto count = ::read(descriptor, buffer, requested);
            if (count < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw scryer::ScryerError("IO_ERROR");
            }
            if (count == 0) {
                break;
            }
            document.append(buffer, static_cast<std::size_t>(count));
            if (document.size() > kMaxDocumentBytes) {
                throw scryer::ScryerError("INPUT_TOO_LARGE");
            }
        }
    } catch (...) {
        if (input) {
            ::close(descriptor);
        }
        throw;
    }
    if (input && ::close(descriptor) != 0) {
        throw scryer::ScryerError("IO_ERROR");
    }
    return document;
}

void write_all(int descriptor, std::string_view body) {
    while (!body.empty()) {
        const auto count = ::write(descriptor, body.data(), body.size());
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw scryer::ScryerError("IO_ERROR");
        }
        if (count == 0) {
            throw scryer::ScryerError("IO_ERROR");
        }
        body.remove_prefix(static_cast<std::size_t>(count));
    }
}

void write_document(std::string_view body, const std::optional<std::string>& output) {
    if (!output) {
        write_all(STDOUT_FILENO, body);
        return;
    }
    std::string temporary = *output + ".tmp.XXXXXX";
    std::vector<char> path(temporary.begin(), temporary.end());
    path.push_back('\0');
    int descriptor = ::mkstemp(path.data());
    if (descriptor < 0) {
        throw scryer::ScryerError("IO_ERROR");
    }
    try {
        write_all(descriptor, body);
        if (::fsync(descriptor) != 0) {
            throw scryer::ScryerError("IO_ERROR");
        }
        const int close_result = ::close(descriptor);
        descriptor = -1;
        if (close_result != 0) {
            throw scryer::ScryerError("IO_ERROR");
        }
        if (::rename(path.data(), output->c_str()) != 0) {
            throw scryer::ScryerError("IO_ERROR");
        }
    } catch (...) {
        if (descriptor >= 0) {
            ::close(descriptor);
        }
        ::unlink(path.data());
        throw;
    }
}

int exit_code(std::string_view code) {
    if (code == "INVALID_CLI_USAGE") {
        return 2;
    }
    if (code == "INVALID_HISTORICAL_RECEIPT") {
        return 4;
    }
    if (code == "IO_ERROR") {
        return 5;
    }
    if (code == "INPUT_TOO_LARGE" || code == "COMPUTATION_LIMIT") {
        return 6;
    }
    return 3;
}

int fail(std::string_view code) {
    try {
        const scryer::Json body = {{"schemaVersion", "1"}, {"error", {{"code", code}}}};
        std::cerr << scryer::canonical_json(body) << '\n';
    } catch (...) {
        std::cerr << "{\"error\":{\"code\":\"COMPUTATION_LIMIT\"},\"schemaVersion\":\"1\"}\n";
        return 6;
    }
    return exit_code(code);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--help") {
            std::cout << "Usage: scryer-native [--input PATH] [--output PATH] | demo | --help | --version\n";
            return std::cout ? 0 : fail("IO_ERROR");
        }
        if (argc == 2 && std::string_view(argv[1]) == "--version") {
            std::cout << "native-0.1.0\n";
            return std::cout ? 0 : fail("IO_ERROR");
        }
        const auto options = parse_options(argc, argv);
        const auto request = options.demo ?
            scryer::Request{scryer::Json{{"schemaVersion", "1"}, {"operation", "demo"}}} :
            scryer::Request{scryer::parse_document(read_document(options.input))};
        const auto response = scryer::evaluate(request);
        const auto bytes = scryer::canonical_json(response.document) + "\n";
        write_document(bytes, options.output);
        return 0;
    } catch (const scryer::ScryerError& error) {
        return fail(error.code());
    } catch (const std::bad_alloc&) {
        return fail("COMPUTATION_LIMIT");
    } catch (const std::exception&) {
        return fail("INTERNAL_ERROR");
    }
}
