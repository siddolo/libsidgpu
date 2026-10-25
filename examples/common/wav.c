#include "sidgpu.h"

#ifdef SIDGPU_OPENGL_ES
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#endif
#include <stdio.h>
#include <stdlib.h>

/* RIFF integers are little-endian regardless of the CPU's byte order. */
static void put16(FILE *file, uint16_t value)
{
    fputc(value & 255, file);
    fputc(value >> 8, file);
}

static void put32(FILE *file, uint32_t value)
{
    put16(file, (uint16_t)value);
    put16(file, (uint16_t)(value >> 16));
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "Usage: %s output.wav\n", argv[0]);
        return EXIT_FAILURE;
    }
    int result = EXIT_FAILURE;
    sidgpu *engine = NULL;
    FILE *file = NULL;
#ifdef SIDGPU_OPENGL_ES
    /* The pbuffer only supplies a surface for the current EGL context. SID
     * rendering uses separate framebuffer textures, so 1x1 is sufficient. */
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, NULL, NULL)) goto egl_error;
    if (!eglBindAPI(EGL_OPENGL_ES_API)) goto egl_error;
    const EGLint config_attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE
    };
    EGLConfig config;
    EGLint count;
    if (!eglChooseConfig(display, config_attributes, &config, 1, &count) || count == 0) goto egl_error;
    const EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    const EGLint surface_attributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attributes);
    surface = eglCreatePbufferSurface(display, config, surface_attributes);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE ||
        !eglMakeCurrent(display, surface, surface, context)) goto egl_error;
#endif

    char error[1024];
    engine = sidgpu_create(48000, 256, SIDGPU_CLOCK_PAL, error, sizeof(error));
    if (!engine) {
        fprintf(stderr, "%s\n", error);
        goto cleanup;
    }
#ifdef SIDGPU_OPENGL_ES
    fprintf(stderr, "OpenGL ES renderer: %s\n", glGetString(GL_RENDERER));
#endif
    /* The 16-bit frequency register increments a 24-bit phase accumulator on
     * each SID clock: Hz = register * clock / 2^24. Round A4 to the nearest step. */
    const double tone_hz = 440.0;
    const uint32_t phase_modulus = 1u << 24;
    unsigned frequency = (unsigned)(tone_hz * phase_modulus / SIDGPU_CLOCK_PAL + 0.5);
    /* Voice 1: frequency low/high bytes, minimum attack/decay, full sustain
     * with release rate 8, then sawtooth + Gate (0x21). Register 24 sets volume
     * to 15 with the filter modes disabled. All writes precede the first sample. */
    const unsigned registers[][2] = {
        {0, frequency & 255}, {1, frequency >> 8}, {5, 0}, {6, 0xf8}, {4, 0x21}, {24, 15}
    };
    for (unsigned i = 0; i < sizeof(registers) / sizeof(registers[0]); i++) {
        if (sidgpu_schedule_write(engine, 0, registers[i][0], registers[i][1])) goto engine_error;
    }
    /* At 1.5 seconds, clear Gate but retain the sawtooth bit. The remaining
     * half-second of the file captures the envelope's release to silence. */
    if (sidgpu_schedule_write(engine, 72000, 4, 0x20)) goto engine_error;

    file = fopen(argv[1], "wb");
    if (!file) {
        perror(argv[1]);
        goto cleanup;
    }
    const unsigned samples = 96000;
    /* The 44-byte PCM WAV header consists of RIFF/WAVE (12 bytes), fmt (24)
     * and the data chunk header (8). RIFF's size excludes its first 8 bytes,
     * giving 36 + PCM bytes. The fmt payload is 16 bytes, with format tag 1
     * for integer PCM, one channel and 16 bits at 48000 Hz: 2 bytes per frame,
     * or 96000 bytes per second. */
    fwrite("RIFF", 1, 4, file);
    put32(file, 36 + samples * 2);
    fwrite("WAVEfmt ", 1, 8, file);
    put32(file, 16);
    put16(file, 1);
    put16(file, 1);
    put32(file, 48000);
    put32(file, 96000);
    put16(file, 2);
    put16(file, 16);
    fwrite("data", 1, 4, file);
    put32(file, samples * 2);
    for (unsigned offset = 0; offset < samples; offset += 256) {
        int16_t pcm[256];
        if (sidgpu_render(engine, pcm)) goto engine_error;
        unsigned count = samples - offset < 256 ? samples - offset : 256;
        /* Preserve the signed PCM bit pattern when emitting its two bytes. */
        for (unsigned i = 0; i < count; i++) put16(file, (uint16_t)pcm[i]);
    }
    if (ferror(file)) {
        fprintf(stderr, "Failed writing %s\n", argv[1]);
        goto cleanup;
    }
    result = EXIT_SUCCESS;
    goto cleanup;

engine_error:
    fprintf(stderr, "%s\n", sidgpu_error(engine));
    goto cleanup;
#ifdef SIDGPU_OPENGL_ES
egl_error:
    fprintf(stderr, "EGL initialization failed: 0x%x\n", eglGetError());
#endif
cleanup:
    if (file && fclose(file) != 0) {
        perror(argv[1]);
        result = EXIT_FAILURE;
    }
    /* OpenGL ES resources must be freed while their context is still current. */
    sidgpu_destroy(engine);
#ifdef SIDGPU_OPENGL_ES
    if (display != EGL_NO_DISPLAY) {
        eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
        if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
        eglTerminate(display);
    }
#endif
    return result;
}
