export function getLocaleOverrideScript(
  locale: string,
  timeZone: string,
): string {
  return `
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
      value: function () {
        return {
          locale: '${locale}',
          timeZone: '${timeZone}'
        };
      }
    });
    Object.defineProperty(navigator, 'language', { get: () => '${locale}' });
    Object.defineProperty(navigator, 'languages', { get: () => ['${locale}'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux aarch64' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(window, 'innerWidth', { get: () => 1 });
    Object.defineProperty(window, 'innerHeight', { get: () => 1 });
    Object.defineProperty(window, 'isInIframe', { get: () => true });
    Object.defineProperty(Notification, 'permission', { get: () => 'unknown' });

    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'type', { get: () => '4g' });
    }

    navigator.getGamepads = () => [1, 1, 1, 1];
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    if (window.chrome) {
      delete window.chrome;
    }

    Object.defineProperty(window, 'chrome', {
      get: () => undefined,
      configurable: true
    });

    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      const BASIC_MOBILE_EXTENSIONS = [
        "ANGLE_instanced_arrays",
        "EXT_blend_minmax",
        "EXT_float_blend",
        "EXT_texture_filter_anisotropic",
        "EXT_sRGB",
        "OES_element_index_uint",
        "OES_fbo_render_mipmap",
        "OES_standard_derivatives",
        "OES_vertex_array_object",
        "WEBGL_compressed_texture_astc",
        "WEBGL_compressed_texture_etc",
        "WEBGL_compressed_texture_etc1",
        "WEBGL_debug_renderer_info",
        "WEBGL_debug_shaders",
        "WEBGL_depth_texture",
        "WEBGL_lose_context",
        "WEBGL_multi_draw"
      ];

      if (param === 37445) return 'WebKit';
      if (param === 37446) return 'Mali-G52 MC2';
      if (param === 7936) return 'WebKit';
      if (param === 7937) return 'WebKit WebGL';
      if (param === 7938) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
      if (param === 35724) return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
      if (param === 7939) return BASIC_MOBILE_EXTENSIONS;
      return origGetParameter.call(this, param);
    };

    window.__availableFonts = [
      "Arial",
      "Helvetica",
      "Times New Roman",
      "Courier",
      "Verdana",
      "Georgia",
      "Palatino",
      "Tahoma"
    ];
    window.__fontsCount = 8;
    window.__fontsFamilyGroups = { windows: 1, macos: 0, linux: 0, mobile: 0 };
  `;
}
