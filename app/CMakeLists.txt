cmake_minimum_required(VERSION 3.26)
project(awsm_app LANGUAGES C)

# The app thread: your game (src/game/) and the runtime that runs it
# (src/runtime/), in C23, compiled to WebAssembly with Emscripten. There is no native build: the tests are wasm too, and run under
# node. See CMakePresets.json for the two configurations (`wasm`, `wasm-dev`).
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
        "This project only builds with Emscripten. Configure it through a preset:\n"
        "  cmake --preset wasm-dev      (or run `task setup`)")
endif()

# --- Language standard -------------------------------------------------------
set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)
# GNU C23 (-std=gnu23), not strict -std=c23: strict mode rejects Emscripten's
# EM_ASM / EM_JS macros and hides POSIX declarations (usleep, strdup, M_PI…).
# -Wpedantic still flags GNU syntax in your own code.
set(CMAKE_C_EXTENSIONS ON)

# compile_commands.json, which is what clangd (your editor) reads. app/.clangd
# points at the wasm-dev one.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# --- Warnings ------------------------------------------------------------------
add_library(project_options INTERFACE)
target_compile_options(project_options INTERFACE
    -Wall -Wextra -Wpedantic
    -Wshadow -Wconversion -Wsign-conversion
    -Wstrict-prototypes -Wmissing-prototypes
    -Werror=implicit-function-declaration
)

# --- Making the compile database work in any editor -----------------------------
# emcc adds its target, sysroot and system include directories internally, so
# they never reach compile_commands.json and clangd would look at the host's
# headers instead. Ask emcc for them (`emcc --cflags`) and repeat the ones
# clangd needs. For emcc itself this changes nothing, but it makes the compile
# database self-describing: any clangd gets <emscripten.h> and friends right
# with no per-machine setup.
# (These are real compile options: if you ever switch to wasm64 with
# -sMEMORY64, drop the wasm32 --target here or emcc will refuse it.)
execute_process(COMMAND "${CMAKE_C_COMPILER}" --cflags
    OUTPUT_VARIABLE _em_cflags RESULT_VARIABLE _em_rc
    OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
set(_em_editor_flags "")
if(_em_rc EQUAL 0)
    # Homebrew: emcc reports its sysroot under Cellar/emscripten/<version>/;
    # prefer the version-independent opt/ symlink, so the compile database
    # (and the editor) keep working across `brew upgrade`.
    string(REGEX REPLACE "/Cellar/emscripten/[^/ ]+/" "/opt/emscripten/"
        _em_cflags_stable "${_em_cflags}")
    if(_em_cflags_stable MATCHES "--sysroot=([^ ]+)")
        # (Nested: ${CMAKE_MATCH_1} would expand before MATCHES runs.)
        if(IS_DIRECTORY "${CMAKE_MATCH_1}")
            set(_em_cflags "${_em_cflags_stable}")
        endif()
    endif()
    separate_arguments(_em_cflags UNIX_COMMAND "${_em_cflags}")
    set(_prev "")
    foreach(_f IN LISTS _em_cflags)
        if(_prev STREQUAL "-target")
            list(APPEND _em_editor_flags "--target=${_f}")
        elseif(_f MATCHES "^--target=")
            list(APPEND _em_editor_flags "${_f}")
        elseif(_f MATCHES "^--sysroot=")
            list(APPEND _em_editor_flags "${_f}")
        elseif(_prev STREQUAL "-Xclang" AND _f MATCHES "^-(iwithsysroot|isystem|idirafter)")
            # The single-token driver form: CMake de-duplicates repeated
            # options, which would mangle -Xclang pairs.
            list(APPEND _em_editor_flags "${_f}")
        endif()
        set(_prev "${_f}")
    endforeach()
endif()
# Fallbacks, each independent, in case emcc's output format ever changes.
if(NOT _em_editor_flags MATCHES "--target=")
    list(APPEND _em_editor_flags --target=wasm32-unknown-emscripten)
endif()
if(NOT _em_editor_flags MATCHES "--sysroot=" AND DEFINED EMSCRIPTEN_SYSROOT)
    list(APPEND _em_editor_flags "--sysroot=${EMSCRIPTEN_SYSROOT}")
endif()
target_compile_options(project_options INTERFACE ${_em_editor_flags})

# Re-run configure automatically (on the next build) when Emscripten is
# upgraded, so the flags above stay current.
if(EXISTS "${EMSCRIPTEN_ROOT_PATH}/emscripten-version.txt")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${EMSCRIPTEN_ROOT_PATH}/emscripten-version.txt")
endif()

# --- Shared memory ----------------------------------------------------------------
# The bridge block lives in this module's memory, and the page and the
# renderer read it from other threads, so the memory must be a
# SharedArrayBuffer. -pthread is what makes it one (and it provides the
# atomics the bridge is built on). wasm-ld refuses shared memory unless EVERY
# object was compiled for it, hence a directory-wide option.
# -matomics -mbulk-memory are implied by -pthread; spelling them out puts them
# in compile_commands.json, where clangd needs them.
add_compile_options(-pthread -matomics -mbulk-memory)
add_link_options(-pthread)

# --- Library: the app itself, shared by the browser entry point and the tests -----
# Your game is every .c file in src/game/, picked up on the next build (no
# edit here when you add one). The runtime's files are listed. One library,
# because the two call each other (the runtime calls the game's hooks, the
# game calls runtime_*). Headers are included by their path under src/:
# "game/game.h", "runtime/runtime.h".
file(GLOB GAME_SOURCES CONFIGURE_DEPENDS src/game/*.c)
add_library(core
    ${GAME_SOURCES}
    src/runtime/bridge.c
    src/runtime/fixed_step.c
    src/runtime/runtime.c
)
target_include_directories(core PUBLIC src)
target_link_libraries(core PRIVATE project_options)

# --- The browser module: app.js + app.wasm ----------------------------------------
add_executable(app src/runtime/web_main.c)
target_link_libraries(app PRIVATE core project_options)
target_link_options(app PRIVATE
    # app.js is an ES module whose default export instantiates the wasm:
    #   import createApp from './app.js';  const module = await createApp();
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    # Only ever loaded by app/web/worker.js, a module worker.
    -sENVIRONMENT=worker
    # FIXED-size memory. The page and the renderer hold views of this memory's
    # buffer for the whole session; growing it would replace the buffer under
    # them. So it is sized once, here: far more than this demo needs. Raise it
    # if your app allocates more (malloc fails when it runs out). A multiple
    # of 64 KB.
    -sINITIAL_MEMORY=32MB
    -sALLOW_MEMORY_GROWTH=0
    # The worker posts `module.wasmMemory.buffer` (the SharedArrayBuffer) to
    # the page.
    -sEXPORTED_RUNTIME_METHODS=wasmMemory
    # No main(): JavaScript calls the EMSCRIPTEN_KEEPALIVE exports of web_main.c.
    --no-entry
    $<$<CONFIG:Debug>:-sASSERTIONS=1>
)
# The result is app.js + app.wasm in this preset's own build tree
# (app/build/<preset>/). The page loads them from dist/app/, next to
# web/worker.js; taskfile/app.yml copies them there.

# --- Tests --------------------------------------------------------------------------
# Ordinary C programs with a main(), compiled to wasm like everything else.
# Emscripten's toolchain tells ctest to run them with node. Every
# tests/runtime/test_<name>.c and tests/game/test_<name>.c is a test called
# <name> (so a new test_*.c in tests/game/ needs no edit here). They include
# "runtime/check.h" from tests/.
enable_testing()
file(GLOB TEST_SOURCES CONFIGURE_DEPENDS tests/runtime/test_*.c tests/game/test_*.c)
foreach(_source IN LISTS TEST_SOURCES)
    get_filename_component(_target "${_source}" NAME_WE)
    string(REGEX REPLACE "^test_" "" _name "${_target}")
    add_executable(${_target} "${_source}")
    target_include_directories(${_target} PRIVATE tests)
    target_link_libraries(${_target} PRIVATE core project_options)
    add_test(NAME ${_name} COMMAND ${_target})
endforeach()

# The cross-language layout check: bridge_layout prints what THIS compiler
# makes of bridge.h, and the script compares the Rust and JS mirrors with it.
add_executable(bridge_layout tests/runtime/bridge_layout.c)
target_link_libraries(bridge_layout PRIVATE core project_options)
find_program(NODE_EXECUTABLE node REQUIRED)
add_test(NAME bridge_mirrors
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/../tools/check-bridge.mjs"
            $<TARGET_FILE:bridge_layout>)
