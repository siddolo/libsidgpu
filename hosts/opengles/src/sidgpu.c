#include "sidgpu_internal.h"
#include "shaders.h"

#include <GLES3/gl3.h>
#include <stdio.h>
#include <stdlib.h>

/* OpenGL ES 3.0 host implementation.
 *
 * A fragment shader cannot scatter writes to arbitrary texels, so synthesis is
 * split into 32-sample checkpoint segments. Each segment runs two fragment
 * passes that read the same input state texture `textures[current]`:
 *
 *                         +-- state_program --> framebuffers[1 - current] (11x1)
 *   textures[current] ----|
 *                         +-- pcm_program ----> framebuffers[2] viewport [offset .. offset + 32)
 *
 * After both draws complete, `1 - current` becomes the input checkpoint for the
 * next 32-sample segment. Once all segments of `block_size` have been drawn into
 * `framebuffers[2]`, a single `glReadPixels` call reads the full block and
 * unpacks offset-binary RGBA8 texels into signed 16-bit PCM. */

struct program {
    GLuint id;
    GLint count, event_count, pcm_offset;
};

struct sidgpu {
    uint32_t sample_rate, block_size, clock;
    uint64_t next_sample;
    GLuint textures[3], framebuffers[3], event_texture, vao; /* Array entries: state A, state B, PCM. */
    struct program state_program, pcm_program;
    unsigned current, max_events;
    struct sidgpu_events events;
    uint32_t event_data[SIDGPU_MAX_SEGMENT_EVENTS * 4];
    uint8_t pcm_data[SIDGPU_MAX_BLOCK_SAMPLES * 4];
    int failed;
    char error[1024];
};

static int check_gl(sidgpu *engine)
{
    GLenum error = glGetError();
    if (error == GL_NO_ERROR) return 0;
    snprintf(engine->error, sizeof(engine->error), "OpenGL ES error 0x%x", error);
    /* Some draws may already have changed the checkpoint. Continuing would
     * make the CPU timeline disagree with the GPU state, so this is fatal. */
    engine->failed = 1;
    return -1;
}

/* Both passes use the shared SID model and a vertex shader whose gl_VertexID
 * generates a full-screen triangle. PACKED_PCM encodes output in RGBA8 so the
 * host does not require floating-point render targets. */
static int build_program(sidgpu *engine, struct program *program, const char *fragment)
{
    const GLchar *sources[] = {
        "#version 300 es\n#define PACKED_PCM\n", opengles_interface_glsl, common_glsl, oscillator_glsl,
        envelope_glsl, filter_glsl, fragment
    };
    const GLenum types[] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    program->id = glCreateProgram();
    if (!program->id) {
        snprintf(engine->error, sizeof(engine->error), "Could not create GLSL program");
        return -1;
    }
    for (unsigned i = 0; i < 2; i++) {
        GLuint shader = glCreateShader(types[i]);
        if (!shader) {
            snprintf(engine->error, sizeof(engine->error), "Could not create GLSL shader");
            return -1;
        }
        const GLchar *vertex = opengles_fullscreen_vert_glsl;
        glShaderSource(shader, i == 0 ? 1 : 7, i == 0 ? &vertex : sources, NULL);
        glCompileShader(shader);
        GLint compiled = GL_FALSE;
        glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
        if (!compiled) {
            glGetShaderInfoLog(shader, sizeof(engine->error), NULL, engine->error);
            glDeleteShader(shader);
            return -1;
        }
        glAttachShader(program->id, shader);
        /* Attached shaders remain alive until their program releases them. */
        glDeleteShader(shader);
    }
    glLinkProgram(program->id);
    GLint linked = GL_FALSE;
    glGetProgramiv(program->id, GL_LINK_STATUS, &linked);
    if (!linked) {
        glGetProgramInfoLog(program->id, sizeof(engine->error), NULL, engine->error);
        return -1;
    }
    /* Texture units and timing stay fixed for this engine. Cache the locations
     * used by the rendering loop to avoid per-draw name lookups. */
    glUseProgram(program->id);
    glUniform1i(glGetUniformLocation(program->id, "initialState"), 0);
    glUniform1i(glGetUniformLocation(program->id, "events"), 1);
    glUniform1i(glGetUniformLocation(program->id, "sampleRate"), (GLint)engine->sample_rate);
    glUniform1ui(glGetUniformLocation(program->id, "clockFrequency"), engine->clock);
    glUniform1i(glGetUniformLocation(program->id, "parallelOscillator"), GL_FALSE);
    program->count = glGetUniformLocation(program->id, "count");
    program->event_count = glGetUniformLocation(program->id, "eventCount");
    program->pcm_offset = glGetUniformLocation(program->id, "pcmOffset");
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
    if (!glGetString(GL_VERSION)) {
        if (error && error_size) snprintf(error, error_size, "A current OpenGL ES 3 context is required");
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
    GLint max_texture_size;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_texture_size);
    /* Each event occupies one texel in a single-row integer texture. */
    engine->max_events = max_texture_size < SIDGPU_MAX_SEGMENT_EVENTS ? (unsigned)max_texture_size : SIDGPU_MAX_SEGMENT_EVENTS;

    /* These passes store data. In particular, dithering could change the
     * bytes that carry packed PCM samples in the normalized RGBA8 target. */
    glDisable(GL_BLEND);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_DITHER);
    glGenVertexArrays(1, &engine->vao);
    glBindVertexArray(engine->vao);
    glGenTextures(3, engine->textures);
    glGenFramebuffers(3, engine->framebuffers);
    uint32_t state[SIDGPU_STATE_WORDS] = {0};
    /* Elements 0..6 contain registers; 7..9 contain voice state. Seed each
     * 23-bit noise LFSR with all ones and select envelope stage 2 (release).
     * Zero envelope levels and zero volume keep the initial output silent. */
    for (unsigned voice = 0; voice < 3; voice++) {
        state[(7 + voice) * 4 + 1] = 0x7fffff;
        state[(7 + voice) * 4 + 3] = 2;
    }
    glActiveTexture(GL_TEXTURE0);
    /* The two RGBA32UI checkpoints preserve exact state words, including
     * bit-cast envelope/filter floats. The third texture holds one PCM block. */
    for (unsigned i = 0; i < 3; i++) {
        glBindTexture(GL_TEXTURE_2D, engine->textures[i]);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexImage2D(GL_TEXTURE_2D, 0, i < 2 ? GL_RGBA32UI : GL_RGBA8,
                     i < 2 ? SIDGPU_STATE_ELEMENTS : (GLsizei)block_size, 1, 0,
                     i < 2 ? GL_RGBA_INTEGER : GL_RGBA,
                     i < 2 ? GL_UNSIGNED_INT : GL_UNSIGNED_BYTE, i < 2 ? state : NULL);
        glBindFramebuffer(GL_FRAMEBUFFER, engine->framebuffers[i]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, engine->textures[i], 0);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            snprintf(engine->error, sizeof(engine->error), "Incomplete framebuffer %u", i);
            goto fail;
        }
    }
    glGenTextures(1, &engine->event_texture);
    glBindTexture(GL_TEXTURE_2D, engine->event_texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    if (build_program(engine, &engine->state_program, opengles_state_update_frag_glsl) ||
        build_program(engine, &engine->pcm_program, opengles_pcm_render_frag_glsl) || check_gl(engine)) goto fail;
    return engine;

fail:
    if (error && error_size) snprintf(error, error_size, "%s", engine->error);
    sidgpu_destroy(engine);
    return NULL;
}

void sidgpu_destroy(sidgpu *engine)
{
    if (!engine) return;
    glDeleteProgram(engine->state_program.id);
    glDeleteProgram(engine->pcm_program.id);
    glDeleteTextures(3, engine->textures);
    glDeleteTextures(1, &engine->event_texture);
    glDeleteFramebuffers(3, engine->framebuffers);
    glDeleteVertexArrays(1, &engine->vao);
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
    /* Validate every segment before submitting any state updates. Rejecting
     * a later segment must not leave an earlier one partially rendered. */
    size_t cursor = 0;
    for (unsigned offset = 0; offset < engine->block_size; offset += SIDGPU_CHECKPOINT_SAMPLES) {
        size_t start = cursor;
        uint64_t end = engine->next_sample + offset + SIDGPU_CHECKPOINT_SAMPLES;
        while (cursor < engine->events.count && engine->events.items[cursor].sample < end) cursor++;
        if (cursor - start > engine->max_events) {
            snprintf(engine->error, sizeof(engine->error), "Too many events in a checkpoint (maximum %u)", engine->max_events);
            return -1;
        }
    }
    cursor = 0;
    glBindVertexArray(engine->vao);
    for (unsigned offset = 0; offset < engine->block_size; offset += SIDGPU_CHECKPOINT_SAMPLES) {
        unsigned count = 0;
        uint64_t end = engine->next_sample + offset + SIDGPU_CHECKPOINT_SAMPLES;
        /* Shader events carry a checkpoint-relative sample offset, register
         * address, value and type. The strict end bound defers boundary events
         * to the next checkpoint while preserving equal-time insertion order. */
        while (cursor < engine->events.count && engine->events.items[cursor].sample < end) {
            const struct sidgpu_event *event = &engine->events.items[cursor++];
            engine->event_data[count * 4] = (uint32_t)(event->sample - engine->next_sample - offset);
            engine->event_data[count * 4 + 1] = event->address;
            engine->event_data[count * 4 + 2] = event->value;
            engine->event_data[count * 4 + 3] = event->type;
            count++;
        }
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, engine->event_texture);
        /* Keep the sampler complete even with no events; eventCount prevents
         * the shaders from reading the unused texel in that case. */
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32UI, count ? (GLsizei)count : 1, 1, 0,
                     GL_RGBA_INTEGER, GL_UNSIGNED_INT, engine->event_data);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, engine->textures[engine->current]);
        /* Both passes read the same checkpoint. Swap state only after PCM has
         * been reconstructed from it, not immediately after the state pass. */
        for (unsigned pass = 0; pass < 2; pass++) {
            const struct program *program = pass == 0 ? &engine->state_program : &engine->pcm_program;
            glUseProgram(program->id);
            glUniform1i(program->count, SIDGPU_CHECKPOINT_SAMPLES);
            glUniform1i(program->event_count, (GLint)count);
            glUniform1i(program->pcm_offset, (GLint)offset);
            glBindFramebuffer(GL_FRAMEBUFFER, engine->framebuffers[pass == 0 ? 1 - engine->current : 2]);
            glViewport(pass == 0 ? 0 : (GLint)offset, 0,
                       pass == 0 ? SIDGPU_STATE_ELEMENTS : SIDGPU_CHECKPOINT_SAMPLES, 1);
            glDrawArrays(GL_TRIANGLES, 0, 3);
        }
        engine->current = 1 - engine->current;
    }
    /* The last PCM framebuffer is still bound. Reading into CPU memory waits
     * for the block's draws; no separate fence is needed for this blocking API. */
    glReadPixels(0, 0, (GLsizei)engine->block_size, 1, GL_RGBA, GL_UNSIGNED_BYTE, engine->pcm_data);
    if (check_gl(engine)) return -1;
    /* R carries the low byte and G the high byte of offset-binary PCM16.
     * Subtract its midpoint (32768) to recover signed samples; B/A are unused. */
    for (unsigned i = 0; i < engine->block_size; i++) {
        pcm[i] = (int16_t)((int)engine->pcm_data[i * 4] + 256 * engine->pcm_data[i * 4 + 1] - 32768);
    }
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
    glBindFramebuffer(GL_FRAMEBUFFER, engine->framebuffers[engine->current]);
    glReadPixels(0, 0, SIDGPU_STATE_ELEMENTS, 1, GL_RGBA_INTEGER, GL_UNSIGNED_INT, state);
    return check_gl(engine);
}
