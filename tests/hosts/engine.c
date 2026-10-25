#include "sidgpu.h"

#ifdef SIDGPU_OPENGL_ES
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
        exit(EXIT_FAILURE); \
    } \
} while (0)

static sidgpu *create(unsigned rate, unsigned block, unsigned clock)
{
    char error[1024];
    sidgpu *engine = sidgpu_create(rate, block, clock, error, sizeof(error));
    if (!engine) {
        fprintf(stderr, "%s\n", error);
        exit(EXIT_FAILURE);
    }
    return engine;
}

static void render(sidgpu *engine, int16_t *pcm)
{
    if (sidgpu_render(engine, pcm)) {
        fprintf(stderr, "%s\n", sidgpu_error(engine));
        exit(EXIT_FAILURE);
    }
}

static void tone(sidgpu *engine, uint64_t sample, unsigned frequency, unsigned waveform)
{
    CHECK(sidgpu_schedule_write(engine, sample, 0, frequency & 255) == 0);
    CHECK(sidgpu_schedule_write(engine, sample, 1, frequency >> 8) == 0);
    CHECK(sidgpu_schedule_write(engine, sample, 4, waveform | 1) == 0);
    CHECK(sidgpu_schedule_write(engine, sample, 5, 0) == 0);
    CHECK(sidgpu_schedule_write(engine, sample, 6, 0xf0) == 0);
    CHECK(sidgpu_schedule_write(engine, sample, 24, 15) == 0);
}

/* Verify that the 24-bit phase accumulator and 23-bit noise LFSR match the 18
 * reference vectors generated from reSID (MOS8580, delta-clocked) across
 * 44.1/48 kHz sample rates, frequencies 0/7492/65535 and 128/1024/4096 samples. */
static void reference_vectors(void)
{
    static const struct { unsigned rate, frequency, samples, phase, lfsr; } vectors[] = {
#include "reference.h"
    };
    for (unsigned i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        sidgpu *engine = create(vectors[i].rate, 128, SIDGPU_CLOCK_PAL);
        tone(engine, 0, vectors[i].frequency, 0x80);
        int16_t pcm[128];
        for (unsigned sample = 0; sample < vectors[i].samples; sample += 128) render(engine, pcm);
        uint32_t state[SIDGPU_STATE_WORDS];
        CHECK(sidgpu_snapshot(engine, state) == 0);
        CHECK(state[28] == vectors[i].phase);
        CHECK(state[29] == vectors[i].lfsr);
        CHECK(sidgpu_next_sample(engine) == vectors[i].samples);
        sidgpu_destroy(engine);
    }
}

/* Verify sample-accurate event ordering, same-sample reset/write precedence,
 * rejection of past timestamps or invalid registers, and atomic rollback when a
 * checkpoint exceeds SIDGPU_MAX_SEGMENT_EVENTS. */
static void timeline(void)
{
    sidgpu *engine = create(48000, 128, SIDGPU_CLOCK_PAL);
    int16_t pcm[128];
    uint32_t state[SIDGPU_STATE_WORDS];
    CHECK(sidgpu_schedule_write(engine, 128, 24, 7) == 0);
    tone(engine, 0, 7492, 0x20);
    CHECK(sidgpu_schedule_reset(engine, 127) == 0);
    CHECK(sidgpu_schedule_write(engine, 127, 0, 7) == 0);
    CHECK(sidgpu_schedule_write(engine, 127, 0, 9) == 0);
    CHECK(sidgpu_schedule_write(engine, 128, 4, 0x21) == 0);
    CHECK(sidgpu_schedule_write(engine, 0, 25, 1) == -1);
    CHECK(sidgpu_schedule_write(engine, 0, 0, 256) == -1);
    CHECK(sidgpu_schedule_write(engine, 0, 4, 0x31) == -1);
    render(engine, pcm);
    CHECK(sidgpu_snapshot(engine, state) == 0);
    CHECK(state[0] == 9 && state[4] == 0 && state[24] == 0);
    CHECK(state[28] == 9 * (SIDGPU_CLOCK_PAL / 48000));
    CHECK(pcm[127] == 0);
    CHECK(sidgpu_schedule_write(engine, 127, 0, 0) == -1);
    CHECK(sidgpu_schedule_reset(engine, 127) == -1);
    render(engine, pcm);
    CHECK(sidgpu_snapshot(engine, state) == 0);
    CHECK(state[4] == 0x21 && state[24] == 7);
    sidgpu_destroy(engine);

    engine = create(48000, 128, SIDGPU_CLOCK_PAL);
    render(engine, pcm);
    for (unsigned i = 0; i < 128; i++) CHECK(pcm[i] == 0);
    for (unsigned i = 0; i < 4097; i++) CHECK(sidgpu_schedule_write(engine, 128, 0, i & 255) == 0);
    CHECK(sidgpu_render(engine, pcm) == -1);
    CHECK(sidgpu_next_sample(engine) == 128);
    CHECK(sidgpu_snapshot(engine, state) == 0);
    CHECK(state[0] == 0 && state[28] == 0);
    sidgpu_destroy(engine);
}

/* Verify that partitioning a 4096-sample timeline with intra-block writes,
 * Gate retriggers and a mid-stream reset across block sizes 128..2048 produces
 * bit-identical PCM and final state on both PAL and NTSC clocks. */
static void block_continuity(void)
{
    const unsigned clocks[] = {SIDGPU_CLOCK_PAL, SIDGPU_CLOCK_NTSC};
    const unsigned blocks[] = {128, 256, 512, 1024, 2048};
    int16_t expected[4096], pcm[4096];
    uint32_t expected_state[SIDGPU_STATE_WORDS], state[SIDGPU_STATE_WORDS];
    for (unsigned clock = 0; clock < 2; clock++) {
        for (unsigned block = 0; block < 5; block++) {
            sidgpu *engine = create(48000, blocks[block], clocks[clock]);
            tone(engine, 0, 7492, 0x20);
            CHECK(sidgpu_schedule_write(engine, 1024, 4, 0x20) == 0);
            CHECK(sidgpu_schedule_write(engine, 17, 0, 93) == 0);
            CHECK(sidgpu_schedule_write(engine, 31, 22, 64) == 0);
            CHECK(sidgpu_schedule_write(engine, 32, 4, 0x20) == 0);
            CHECK(sidgpu_schedule_write(engine, 32, 4, 0x21) == 0);
            CHECK(sidgpu_schedule_write(engine, 127, 23, 0xf1) == 0);
            CHECK(sidgpu_schedule_write(engine, 128, 24, 31) == 0);
            CHECK(sidgpu_schedule_reset(engine, 255) == 0);
            tone(engine, 255, 14984, 0x20);
            CHECK(sidgpu_schedule_write(engine, 256, 22, 200) == 0);
            CHECK(sidgpu_schedule_write(engine, 4096, 24, 7) == 0);
            for (unsigned offset = 0; offset < 4096; offset += blocks[block]) render(engine, pcm + offset);
            CHECK(sidgpu_snapshot(engine, state) == 0);
            CHECK(state[24] == 15);
            if (block == 0) {
                memcpy(expected, pcm, sizeof(pcm));
                memcpy(expected_state, state, sizeof(state));
            } else {
                CHECK(memcmp(expected, pcm, sizeof(pcm)) == 0);
                CHECK(memcmp(expected_state, state, sizeof(state)) == 0);
            }
            sidgpu_destroy(engine);
        }
    }
}

/* Measure the sawtooth wrap period of register 7492 at 48 kHz and check that
 * the rendered pitch matches 440 Hz within 0.5 Hz. */
static void tone_frequency(void)
{
    sidgpu *engine = create(48000, 1024, SIDGPU_CLOCK_PAL);
    tone(engine, 0, 7492, 0x20);
    int16_t pcm[1024];
    render(engine, pcm);
    unsigned edges = 0, first = 0, last = 0;
    for (unsigned i = 101; i < 1024; i++) {
        if ((int)pcm[i] - pcm[i - 1] < -6553) {
            if (edges == 0) first = i;
            last = i;
            edges++;
        }
    }
    CHECK(edges > 5);
    double hz = 48000.0 * (edges - 1) / (last - first);
    CHECK(hz > 439.5 && hz < 440.5);
    sidgpu_destroy(engine);
}

int main(void)
{
#ifdef SIDGPU_OPENGL_ES
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    CHECK(display != EGL_NO_DISPLAY);
    CHECK(eglInitialize(display, NULL, NULL));
    CHECK(eglBindAPI(EGL_OPENGL_ES_API));
    const EGLint attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE
    };
    EGLConfig config;
    EGLint count;
    CHECK(eglChooseConfig(display, attributes, &config, 1, &count) && count > 0);
    const EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    const EGLint surface_attributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attributes);
    EGLSurface surface = eglCreatePbufferSurface(display, config, surface_attributes);
    CHECK(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE);
    CHECK(eglMakeCurrent(display, surface, surface, context));
    printf("Renderer: %s\n", glGetString(GL_RENDERER));
#endif
    reference_vectors();
    timeline();
    block_continuity();
    tone_frequency();
#ifdef SIDGPU_OPENGL_ES
    CHECK(glGetError() == GL_NO_ERROR);
    CHECK(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    CHECK(eglDestroySurface(display, surface));
    CHECK(eglDestroyContext(display, context));
    CHECK(eglTerminate(display));
#endif
    puts("reSID vectors, sample timeline, block continuity and A4 frequency passed");
    return EXIT_SUCCESS;
}
