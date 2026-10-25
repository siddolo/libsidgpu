.PHONY: all native opengles vulkan test test-opengles test-vulkan clean

all: native

native: opengles vulkan

opengles vulkan:
	cmake -S hosts/$@ -B hosts/$@/build -DCMAKE_BUILD_TYPE=Release
	cmake --build hosts/$@/build --parallel

test: test-opengles test-vulkan

test-opengles: opengles
	ctest --test-dir hosts/opengles/build --output-on-failure

test-vulkan: vulkan
	ctest --test-dir hosts/vulkan/build --output-on-failure

clean:
	$(RM) -r hosts/opengles/build hosts/vulkan/build
