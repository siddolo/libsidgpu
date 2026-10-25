#include "sidgpu_internal.h"
#include "shader.h"

#include <vulkan/vulkan.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Vulkan compute host implementation.
 *
 * Unlike the two-pass fragment pipeline in OpenGL ES, a compute workgroup of
 * 32 invocations (`render.comp.glsl`) can write both its 32 PCM samples and the
 * 11-texel output checkpoint in a single dispatch.
 *
 * All dispatches for a block are recorded into one command buffer before
 * submission. Because every dispatch reads its events while the command buffer
 * executes on the GPU, `buffers[2]` partitions the event storage into disjoint
 * per-segment slices selected by `parameters[segment].event_offset`:
 *
 *   buffers[0] (state A) <---> descriptors[0] / descriptors[1] <---> buffers[1] (state B)
 *   buffers[2] (events):       [seg 0 events][seg 1 events]...[seg N-1 events]
 *   buffers[3] (int32 PCM):    [seg 0: 0..31][seg 1: 32..63]...[seg N-1]
 *
 * Between segments, a compute-to-compute memory barrier orders the state writes
 * of invocation 31 and the state reads of the completed workgroup before the
 * next dispatch swaps `descriptors[current]` and `descriptors[1 - current]`. */

struct buffer {
    VkBuffer handle;
    VkDeviceMemory memory;
    void *mapped;
    VkDeviceSize size;
};

/* Field order matches the push-constant block in vulkan/interface.glsl.
 * event_offset counts uvec4 events; pcm_offset counts samples, not bytes. */
struct parameters {
    uint32_t clock;
    int32_t sample_rate, event_count, event_offset, pcm_offset;
};

struct sidgpu {
    uint32_t sample_rate, block_size, clock;
    uint64_t next_sample;
    VkInstance instance;
    VkDevice device;
    VkQueue queue;
    VkPhysicalDeviceMemoryProperties memory_properties;
    VkDescriptorSetLayout descriptor_layout;
    VkDescriptorPool descriptor_pool;
    VkDescriptorSet descriptors[2];
    VkPipelineLayout pipeline_layout;
    VkPipeline pipeline;
    VkCommandPool command_pool;
    VkCommandBuffer commands;
    VkFence fence;
    struct buffer buffers[4]; /* State A, state B, events, PCM. */
    unsigned current;
    struct sidgpu_events events;
    int failed;
    char error[1024];
};

static int check_vk(sidgpu *engine, VkResult result, const char *operation)
{
    if (result == VK_SUCCESS) return 0;
    snprintf(engine->error, sizeof(engine->error), "%s failed (VkResult %d)", operation, result);
    /* After a submission or wait failure, GPU progress may be uncertain.
     * Reject further work rather than reuse a potentially advanced checkpoint. */
    engine->failed = 1;
    return -1;
}

static int create_buffer(sidgpu *engine, struct buffer *buffer, VkDeviceSize size)
{
    buffer->size = size;
    VkBufferCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size, .usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE
    };
    if (check_vk(engine, vkCreateBuffer(engine->device, &info, NULL, &buffer->handle), "vkCreateBuffer")) return -1;
    VkMemoryRequirements requirements;
    vkGetBufferMemoryRequirements(engine->device, buffer->handle, &requirements);
    uint32_t type;
    /* The memory type must be allowed by this buffer's requirements as well as
     * CPU-accessible. Coherent mappings avoid explicit flush/invalidate calls;
     * barriers and completion waits still govern when the data can be used. */
    const VkMemoryPropertyFlags flags = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    for (type = 0; type < engine->memory_properties.memoryTypeCount; type++) {
        if ((requirements.memoryTypeBits & (1u << type)) &&
            (engine->memory_properties.memoryTypes[type].propertyFlags & flags) == flags) break;
    }
    if (type == engine->memory_properties.memoryTypeCount) {
        snprintf(engine->error, sizeof(engine->error), "No host-visible coherent storage memory");
        return -1;
    }
    /* Vulkan may require more storage than the logical buffer size. Allocate
     * that full requirement; binding at offset zero satisfies its alignment. */
    VkMemoryAllocateInfo allocation = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = requirements.size, .memoryTypeIndex = type
    };
    if (check_vk(engine, vkAllocateMemory(engine->device, &allocation, NULL, &buffer->memory), "vkAllocateMemory")) return -1;
    if (check_vk(engine, vkBindBufferMemory(engine->device, buffer->handle, buffer->memory, 0), "vkBindBufferMemory")) return -1;
    if (check_vk(engine, vkMapMemory(engine->device, buffer->memory, 0, size, 0, &buffer->mapped), "vkMapMemory")) return -1;
    return 0;
}

sidgpu *sidgpu_create(uint32_t sample_rate, uint32_t block_size, uint32_t clock,
                      char *error, size_t error_size)
{
    if (error && error_size) error[0] = '\0';
    if (sample_rate < 8000 || sample_rate > 192000 ||
        (block_size != 128 && block_size != 256 && block_size != 512 &&
         block_size != 1024 && block_size != SIDGPU_MAX_BLOCK_SAMPLES) ||
        (clock != SIDGPU_CLOCK_PAL && clock != SIDGPU_CLOCK_NTSC)) {
        if (error && error_size) snprintf(error, error_size, "Invalid sample rate, block size or SID clock");
        return NULL;
    }
    sidgpu *engine = calloc(1, sizeof(*engine));
    if (!engine) {
        if (error && error_size) snprintf(error, error_size, "Out of memory");
        return NULL;
    }
    engine->sample_rate = sample_rate;
    engine->block_size = block_size;
    engine->clock = clock;
    VkPhysicalDevice *devices = NULL;
    VkShaderModule shader = VK_NULL_HANDLE;
    VkApplicationInfo application = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "libsidgpu", .apiVersion = VK_API_VERSION_1_0
    };
    VkInstanceCreateInfo instance_info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &application
    };
    if (check_vk(engine, vkCreateInstance(&instance_info, NULL, &engine->instance), "vkCreateInstance")) goto fail;
    uint32_t device_count = 0;
    if (check_vk(engine, vkEnumeratePhysicalDevices(engine->instance, &device_count, NULL), "vkEnumeratePhysicalDevices")) goto fail;
    if (!device_count) {
        snprintf(engine->error, sizeof(engine->error), "No Vulkan devices");
        goto fail;
    }
    devices = malloc(device_count * sizeof(*devices));
    if (!devices) {
        snprintf(engine->error, sizeof(engine->error), "Out of memory");
        goto fail;
    }
    if (check_vk(engine, vkEnumeratePhysicalDevices(engine->instance, &device_count, devices), "vkEnumeratePhysicalDevices")) goto fail;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    uint32_t family = 0;
    /* Take the first device with a compute-capable queue. Synthesis needs no
     * presentation surface or swapchain, so a display connection is unnecessary. */
    for (uint32_t i = 0; i < device_count && !physical; i++) {
        uint32_t count = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(devices[i], &count, NULL);
        VkQueueFamilyProperties *properties = malloc(count * sizeof(*properties));
        if (!properties) {
            snprintf(engine->error, sizeof(engine->error), "Out of memory");
            goto fail;
        }
        vkGetPhysicalDeviceQueueFamilyProperties(devices[i], &count, properties);
        for (uint32_t j = 0; j < count; j++) {
            if (properties[j].queueCount && (properties[j].queueFlags & VK_QUEUE_COMPUTE_BIT)) {
                physical = devices[i];
                family = j;
                break;
            }
        }
        free(properties);
    }
    free(devices);
    devices = NULL;
    if (!physical) {
        snprintf(engine->error, sizeof(engine->error), "No Vulkan compute queue");
        goto fail;
    }
    vkGetPhysicalDeviceMemoryProperties(physical, &engine->memory_properties);
    float priority = 1.0f;
    VkDeviceQueueCreateInfo queue_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = family, .queueCount = 1, .pQueuePriorities = &priority
    };
    VkDeviceCreateInfo device_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount = 1, .pQueueCreateInfos = &queue_info
    };
    if (check_vk(engine, vkCreateDevice(physical, &device_info, NULL, &engine->device), "vkCreateDevice")) goto fail;
    vkGetDeviceQueue(engine->device, family, 0, &engine->queue);
    /* Each checkpoint keeps its own event range until the block completes.
     * Reusing that memory while recording would make earlier dispatches read
     * later checkpoints' events. Events use four uint32 words; PCM uses int32. */
    const VkDeviceSize sizes[] = {
        SIDGPU_STATE_WORDS * sizeof(uint32_t),
        SIDGPU_STATE_WORDS * sizeof(uint32_t),
        (VkDeviceSize)(block_size / SIDGPU_CHECKPOINT_SAMPLES) * SIDGPU_MAX_SEGMENT_EVENTS * 4 * sizeof(uint32_t),
        block_size * sizeof(int32_t)
    };
    for (unsigned i = 0; i < 4; i++) {
        if (create_buffer(engine, &engine->buffers[i], sizes[i])) goto fail;
    }
    uint32_t state[SIDGPU_STATE_WORDS] = {0};
    /* Elements 7..9 hold voice state after the seven register elements. Seed
     * each 23-bit noise LFSR with all ones and select ADSR stage 2 (release).
     * Both checkpoint buffers start with zero envelope levels and volume. */
    for (unsigned voice = 0; voice < 3; voice++) {
        state[(7 + voice) * 4 + 1] = 0x7fffff;
        state[(7 + voice) * 4 + 3] = 2;
    }
    memcpy(engine->buffers[0].mapped, state, sizeof(state));
    memcpy(engine->buffers[1].mapped, state, sizeof(state));

    /* Shader bindings are initial state, events, next state and PCM. They all
     * use storage buffers; the shader declares their read/write access. */
    VkDescriptorSetLayoutBinding bindings[4];
    for (unsigned i = 0; i < 4; i++) {
        bindings[i] = (VkDescriptorSetLayoutBinding){
            .binding = i, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
            .descriptorCount = 1, .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT
        };
    }
    VkDescriptorSetLayoutCreateInfo descriptor_info = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 4, .pBindings = bindings
    };
    if (check_vk(engine, vkCreateDescriptorSetLayout(engine->device, &descriptor_info, NULL, &engine->descriptor_layout),
                 "vkCreateDescriptorSetLayout")) goto fail;
    /* Two ping-pong descriptor sets, each containing four buffer bindings. */
    VkDescriptorPoolSize pool_size = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 8};
    VkDescriptorPoolCreateInfo pool_info = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets = 2, .poolSizeCount = 1, .pPoolSizes = &pool_size
    };
    if (check_vk(engine, vkCreateDescriptorPool(engine->device, &pool_info, NULL, &engine->descriptor_pool),
                 "vkCreateDescriptorPool")) goto fail;
    VkDescriptorSetLayout layouts[] = {engine->descriptor_layout, engine->descriptor_layout};
    VkDescriptorSetAllocateInfo descriptor_allocation = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = engine->descriptor_pool, .descriptorSetCount = 2, .pSetLayouts = layouts
    };
    if (check_vk(engine, vkAllocateDescriptorSets(engine->device, &descriptor_allocation, engine->descriptors),
                 "vkAllocateDescriptorSets")) goto fail;
    /* The two sets share events and PCM, but reverse the state buffers. */
    for (unsigned i = 0; i < 2; i++) {
        const unsigned indices[] = {i, 2, 1 - i, 3};
        VkDescriptorBufferInfo buffers[4];
        VkWriteDescriptorSet writes[4];
        for (unsigned j = 0; j < 4; j++) {
            struct buffer *buffer = &engine->buffers[indices[j]];
            buffers[j] = (VkDescriptorBufferInfo){buffer->handle, 0, buffer->size};
            writes[j] = (VkWriteDescriptorSet){
                .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
                .dstSet = engine->descriptors[i], .dstBinding = j,
                .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                .pBufferInfo = &buffers[j]
            };
        }
        vkUpdateDescriptorSets(engine->device, 4, writes, 0, NULL);
    }
    VkPushConstantRange push = {VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(struct parameters)};
    VkPipelineLayoutCreateInfo layout_info = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &engine->descriptor_layout,
        .pushConstantRangeCount = 1, .pPushConstantRanges = &push
    };
    if (check_vk(engine, vkCreatePipelineLayout(engine->device, &layout_info, NULL, &engine->pipeline_layout),
                 "vkCreatePipelineLayout")) goto fail;
    /* CMake embeds the compiled SPIR-V as uint32 words. Pipeline creation
     * consumes the module; the module itself need not survive afterwards. */
    VkShaderModuleCreateInfo shader_info = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = sizeof(sidgpu_spirv), .pCode = sidgpu_spirv
    };
    if (check_vk(engine, vkCreateShaderModule(engine->device, &shader_info, NULL, &shader), "vkCreateShaderModule")) goto fail;
    VkComputePipelineCreateInfo pipeline_info = {
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = {
            .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
            .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = shader, .pName = "main"
        },
        .layout = engine->pipeline_layout
    };
    if (check_vk(engine, vkCreateComputePipelines(engine->device, VK_NULL_HANDLE, 1, &pipeline_info, NULL, &engine->pipeline),
                 "vkCreateComputePipelines")) goto fail;
    vkDestroyShaderModule(engine->device, shader, NULL);
    shader = VK_NULL_HANDLE;
    VkCommandPoolCreateInfo command_pool_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = family
    };
    if (check_vk(engine, vkCreateCommandPool(engine->device, &command_pool_info, NULL, &engine->command_pool),
                 "vkCreateCommandPool")) goto fail;
    VkCommandBufferAllocateInfo command_allocation = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = engine->command_pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1
    };
    if (check_vk(engine, vkAllocateCommandBuffers(engine->device, &command_allocation, &engine->commands),
                 "vkAllocateCommandBuffers")) goto fail;
    VkFenceCreateInfo fence_info = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    if (check_vk(engine, vkCreateFence(engine->device, &fence_info, NULL, &engine->fence), "vkCreateFence")) goto fail;
    return engine;
fail:
    free(devices);
    if (shader) vkDestroyShaderModule(engine->device, shader, NULL);
    if (error && error_size) snprintf(error, error_size, "%s", engine->error);
    sidgpu_destroy(engine);
    return NULL;
}

void sidgpu_destroy(sidgpu *engine)
{
    if (!engine) return;
    if (engine->device) {
        /* An error can leave submitted work without a successful fence wait.
         * Drain the device before releasing resources referenced by that work. */
        vkDeviceWaitIdle(engine->device);
        vkDestroyFence(engine->device, engine->fence, NULL);
        vkDestroyCommandPool(engine->device, engine->command_pool, NULL);
        vkDestroyPipeline(engine->device, engine->pipeline, NULL);
        vkDestroyPipelineLayout(engine->device, engine->pipeline_layout, NULL);
        vkDestroyDescriptorPool(engine->device, engine->descriptor_pool, NULL);
        vkDestroyDescriptorSetLayout(engine->device, engine->descriptor_layout, NULL);
        for (unsigned i = 0; i < 4; i++) {
            struct buffer *buffer = &engine->buffers[i];
            if (buffer->mapped) vkUnmapMemory(engine->device, buffer->memory);
            vkDestroyBuffer(engine->device, buffer->handle, NULL);
            vkFreeMemory(engine->device, buffer->memory, NULL);
        }
        vkDestroyDevice(engine->device, NULL);
    }
    if (engine->instance) vkDestroyInstance(engine->instance, NULL);
    free(engine->events.items);
    free(engine);
}

const char *sidgpu_error(const sidgpu *engine) { return engine->error; }
uint64_t sidgpu_next_sample(const sidgpu *engine) { return engine->next_sample; }

static int schedule(sidgpu *engine, struct sidgpu_event event)
{
    if (engine->failed) return -1;
    const char *error = sidgpu_events_schedule(&engine->events, engine->next_sample, event);
    if (error) {
        snprintf(engine->error, sizeof(engine->error), "%s", error);
        return -1;
    }
    return 0;
}

int sidgpu_schedule_write(sidgpu *engine, uint64_t sample, unsigned address, unsigned value)
{
    return schedule(engine, (struct sidgpu_event){sample, address, value, SIDGPU_EVENT_WRITE});
}

int sidgpu_schedule_reset(sidgpu *engine, uint64_t sample)
{
    return schedule(engine, (struct sidgpu_event){sample, 0, 0, SIDGPU_EVENT_RESET});
}

int sidgpu_render(sidgpu *engine, int16_t *pcm)
{
    if (engine->failed) return -1;
    if (!pcm) {
        snprintf(engine->error, sizeof(engine->error), "PCM output buffer is required");
        return -1;
    }
    struct parameters parameters[SIDGPU_MAX_CHECKPOINTS];
    uint32_t *data = engine->buffers[2].mapped;
    size_t cursor = 0;
    /* Pack and validate the whole block before recording state updates. A
     * rejected checkpoint must not advance the GPU or consume queued events. */
    for (unsigned offset = 0; offset < engine->block_size; offset += SIDGPU_CHECKPOINT_SAMPLES) {
        size_t start = cursor;
        uint64_t end = engine->next_sample + offset + SIDGPU_CHECKPOINT_SAMPLES;
        while (cursor < engine->events.count && engine->events.items[cursor].sample < end) cursor++;
        if (cursor - start > SIDGPU_MAX_SEGMENT_EVENTS) {
            snprintf(engine->error, sizeof(engine->error), "Too many events in a checkpoint (maximum %d)", SIDGPU_MAX_SEGMENT_EVENTS);
            return -1;
        }
        parameters[offset / SIDGPU_CHECKPOINT_SAMPLES] = (struct parameters){
            engine->clock, (int32_t)engine->sample_rate, (int32_t)(cursor - start), (int32_t)start, (int32_t)offset
        };
        /* event_offset selects this checkpoint's range in the block buffer.
         * Each stored timestamp is relative to the checkpoint's first sample;
         * the strict end bound leaves boundary events for the next range. */
        for (size_t i = start; i < cursor; i++) {
            const struct sidgpu_event *event = &engine->events.items[i];
            data[i * 4] = (uint32_t)(event->sample - engine->next_sample - offset);
            data[i * 4 + 1] = event->address;
            data[i * 4 + 2] = event->value;
            data[i * 4 + 3] = event->type;
        }
    }
    /* A successful render waits for its fence before returning, so the command
     * buffer is no longer pending and its pool can be reset for this block. */
    if (check_vk(engine, vkResetCommandPool(engine->device, engine->command_pool, 0), "vkResetCommandPool")) return -1;
    VkCommandBufferBeginInfo begin = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT
    };
    if (check_vk(engine, vkBeginCommandBuffer(engine->commands, &begin), "vkBeginCommandBuffer")) return -1;
    /* Make CPU event writes, and the initial state on the first block,
     * available to the compute shader. */
    VkMemoryBarrier upload = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_HOST_WRITE_BIT, .dstAccessMask = VK_ACCESS_SHADER_READ_BIT
    };
    vkCmdPipelineBarrier(engine->commands, VK_PIPELINE_STAGE_HOST_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         0, 1, &upload, 0, NULL, 0, NULL);
    vkCmdBindPipeline(engine->commands, VK_PIPELINE_BIND_POINT_COMPUTE, engine->pipeline);
    unsigned current = engine->current;
    for (unsigned segment = 0; segment < engine->block_size / SIDGPU_CHECKPOINT_SAMPLES; segment++) {
        vkCmdBindDescriptorSets(engine->commands, VK_PIPELINE_BIND_POINT_COMPUTE, engine->pipeline_layout,
                                 0, 1, &engine->descriptors[current], 0, NULL);
        vkCmdPushConstants(engine->commands, engine->pipeline_layout, VK_SHADER_STAGE_COMPUTE_BIT,
                             0, sizeof(struct parameters), &parameters[segment]);
        /* One workgroup has 32 invocations, one per PCM sample. The last also
         * writes the complete state from which the next checkpoint starts. */
        vkCmdDispatch(engine->commands, 1, 1, 1);
        /* The next dispatch reads B and overwrites A. Order both checkpoint
         * writes and the previous dispatch's reads before swapping bindings. */
        VkMemoryBarrier checkpoint = {
            .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
            .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
            .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT
        };
        vkCmdPipelineBarrier(engine->commands, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                             0, 1, &checkpoint, 0, NULL, 0, NULL);
        current = 1 - current;
    }
    /* Publish PCM and the final state to host memory. The fence wait below
     * must complete before the CPU reads either mapped buffer. */
    VkMemoryBarrier readback = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT, .dstAccessMask = VK_ACCESS_HOST_READ_BIT
    };
    vkCmdPipelineBarrier(engine->commands, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT,
                         0, 1, &readback, 0, NULL, 0, NULL);
    if (check_vk(engine, vkEndCommandBuffer(engine->commands), "vkEndCommandBuffer")) return -1;
    if (check_vk(engine, vkResetFences(engine->device, 1, &engine->fence), "vkResetFences")) return -1;
    VkSubmitInfo submit = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .commandBufferCount = 1, .pCommandBuffers = &engine->commands
    };
    if (check_vk(engine, vkQueueSubmit(engine->queue, 1, &submit, engine->fence), "vkQueueSubmit")) return -1;
    if (check_vk(engine, vkWaitForFences(engine->device, 1, &engine->fence, VK_TRUE, UINT64_MAX), "vkWaitForFences")) return -1;
    /* The shader already quantized and clamped samples to signed PCM16. Using
     * int32 storage avoids requiring Vulkan's optional 16-bit storage support;
     * narrowing here preserves the sample values without further rounding. */
    const int32_t *samples = engine->buffers[3].mapped;
    for (unsigned i = 0; i < engine->block_size; i++) pcm[i] = (int16_t)samples[i];
    engine->current = current;
    sidgpu_events_consume(&engine->events, cursor);
    engine->next_sample += engine->block_size;
    return 0;
}

int sidgpu_snapshot(sidgpu *engine, uint32_t state[SIDGPU_STATE_WORDS])
{
    if (engine->failed) return -1;
    if (!state) {
        snprintf(engine->error, sizeof(engine->error), "State output buffer is required");
        return -1;
    }
    /* Creation initializes the mapped state, and each successful render waits
     * for its writes to reach host memory. No new GPU transfer is needed. */
    memcpy(state, engine->buffers[engine->current].mapped, SIDGPU_STATE_WORDS * sizeof(*state));
    return 0;
}
