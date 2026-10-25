cmake_minimum_required(VERSION 3.19)
project(libsidgpu-vulkan VERSION 0.1.0 LANGUAGES C)

find_package(Vulkan REQUIRED)
find_program(GLSLANG_VALIDATOR glslangValidator REQUIRED)

file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(source "")
foreach(shader vulkan/interface.glsl common.glsl oscillator.glsl envelope.glsl filter.glsl vulkan/render.comp.glsl)
  set(path "${CMAKE_CURRENT_SOURCE_DIR}/../../shaders/${shader}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${path}")
  file(READ "${path}" part)
  string(APPEND source "${part}\n")
endforeach()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/sid.comp" "${source}")
add_custom_command(
  OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated/shader.h"
  COMMAND "${GLSLANG_VALIDATOR}" -V --target-env vulkan1.0 --vn sidgpu_spirv
          -o "${CMAKE_CURRENT_BINARY_DIR}/generated/shader.h"
          "${CMAKE_CURRENT_BINARY_DIR}/generated/sid.comp"
  DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/generated/sid.comp"
  VERBATIM
)

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()
add_library(sidgpu SHARED src/sidgpu.c ../common/events.c "${CMAKE_CURRENT_BINARY_DIR}/generated/shader.h")
target_compile_features(sidgpu PUBLIC c_std_99)
target_include_directories(sidgpu PUBLIC ../include PRIVATE ../common "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_link_libraries(sidgpu PRIVATE Vulkan::Vulkan)
add_subdirectory(../../examples/vulkan-wav examples/vulkan-wav)

include(CTest)
if(BUILD_TESTING)
  add_subdirectory(../../tests/hosts tests)
endif()
