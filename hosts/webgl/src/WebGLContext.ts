import vertexShader from '../../../shaders/opengles/fullscreen.vert.glsl?raw';

export function createContext(canvas = document.createElement('canvas')) {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL 2 is not available.');
  return gl;
}

/* Link a fragment shader with a vertex shader covering the viewport in one
 * triangle. Draw three vertices without attributes; gl_VertexID supplies their
 * positions. Compilation or link failure throws with the driver log and deletes
 * the unfinished program. The caller owns the successfully linked program. */
export function program(gl: WebGL2RenderingContext, fragment: string) {
  const result = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexShader],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      gl.deleteProgram(result);
      throw new Error(`GLSL compilation failed: ${log}`);
    }
    gl.attachShader(result, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(result);
    gl.deleteProgram(result);
    throw new Error(`GLSL link failed: ${log}`);
  }
  return result;
}

/* Allocate a width-by-one texture and attach it to a framebuffer. Reject formats
 * that cannot form a complete render target on this context. On success both
 * objects remain bound and belong to the caller; on failure both are deleted. */
export function target(gl: WebGL2RenderingContext, width: number, internal: number, format: number, type: number, data: ArrayBufferView | null = null) {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, 1, 0, format, type, data);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error(`Incomplete framebuffer (format ${internal}).`);
  }
  return { texture, framebuffer };
}
