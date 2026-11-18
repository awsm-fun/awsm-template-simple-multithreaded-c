# Finds Emscripten's own CMake toolchain file and includes it.
# Works with both install methods:
#   - emsdk:     uses $EMSDK/upstream/emscripten
#   - Homebrew:  follows the `emcc` on PATH to its libexec dir
set(_em_candidates "")

if(DEFINED ENV{EMSDK})
    list(APPEND _em_candidates "$ENV{EMSDK}/upstream/emscripten")
endif()

find_program(EMCC_EXECUTABLE emcc)
if(EMCC_EXECUTABLE)
    file(REAL_PATH "${EMCC_EXECUTABLE}" _emcc_real)
    get_filename_component(_emcc_dir "${_emcc_real}" DIRECTORY)
    # Homebrew: prefer the version-independent opt/ symlink over
    # Cellar/emscripten/<version>/, so build dirs survive `brew upgrade`.
    if(_emcc_dir MATCHES "^(.*)/Cellar/emscripten/[^/]+(/.*)$")
        if(EXISTS "${CMAKE_MATCH_1}/opt/emscripten${CMAKE_MATCH_2}")
            set(_emcc_dir "${CMAKE_MATCH_1}/opt/emscripten${CMAKE_MATCH_2}")
        endif()
    endif()
    list(APPEND _em_candidates "${_emcc_dir}" "${_emcc_dir}/../libexec")
endif()

foreach(_root IN LISTS _em_candidates)
    set(_tc "${_root}/cmake/Modules/Platform/Emscripten.cmake")
    if(EXISTS "${_tc}")
        include("${_tc}")
        return()
    endif()
endforeach()

message(FATAL_ERROR
    "Could not find Emscripten.\n"
    "Install it with `brew install emscripten` (or emsdk), "
    "then delete app/build/wasm* and re-run.")
