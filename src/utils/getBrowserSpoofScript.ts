export function getBrowserSpoofScript(locale: string, timeZone: string): string {
  const canvasSeed = Math.random() * 10000 + Date.now() % 10000;
  const audioSampleRate = [44100, 48000][Math.floor(Math.random() * 2)];
  const audioBaseLatency = 0.002 + Math.random() * 0.003;

  return `
    (function() {
      'use strict';
      
      const SEED = ${canvasSeed};
      const LOCALE = '${locale}';
      const TIMEZONE = '${timeZone}';
      // ============ 1. TIMEZONE ============
      const OrigDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(loc, options = {}) {
        if (!options.timeZone) options.timeZone = TIMEZONE;
        return new OrigDateTimeFormat(loc || LOCALE, options);
      };
      Intl.DateTimeFormat.prototype = OrigDateTimeFormat.prototype;
      Intl.DateTimeFormat.supportedLocalesOf = OrigDateTimeFormat.supportedLocalesOf;
      Date.prototype.getTimezoneOffset = function() {
        const month = this.getMonth();
        return (month >= 3 && month <= 9) ? -120 : -60; // CET/CEST
      };
      // ============ 2. NAVIGATOR ============
      const defineNav = (prop, value) => {
        try {
          Object.defineProperty(navigator, prop, {
            get: () => value, configurable: true, enumerable: true
          });
        } catch(e) {}
      };
      
      defineNav('language', LOCALE);
      defineNav('languages', Object.freeze([LOCALE]));
      defineNav('platform', 'Linux aarch64');
      defineNav('vendor', '');
      defineNav('maxTouchPoints', 5);
      defineNav('hardwareConcurrency', 8);
      defineNav('deviceMemory', 8);
      defineNav('webdriver', false);
      defineNav('pdfViewerEnabled', true);
      defineNav('cookieEnabled', true);
      defineNav('onLine', true);
      // ============ 3. CANVAS FINGERPRINT ============
      const addNoise = (canvas) => {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            const noise = (Math.sin((i + SEED) * 0.0001) * Math.cos(SEED * 0.0001)) * 2;
            data[i] = Math.max(0, Math.min(255, data[i] + noise));
          }
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {}
      };
      
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        addNoise(this);
        return origToDataURL.apply(this, args);
      };
      
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(...args) {
        addNoise(this);
        return origToBlob.apply(this, args);
      };
      // ============ 4. WEBGL ============
      const WEBGL_EXTENSIONS = [
        "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_float_blend",
        "EXT_texture_filter_anisotropic", "EXT_sRGB", "OES_element_index_uint",
        "OES_fbo_render_mipmap", "OES_standard_derivatives", "OES_texture_float",
        "OES_texture_half_float", "OES_vertex_array_object",
        "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc",
        "WEBGL_compressed_texture_etc1", "WEBGL_debug_renderer_info",
        "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_lose_context",
        "WEBGL_multi_draw"
      ];
      const patchWebGL = (proto) => {
        const origGetParam = proto.getParameter;
        const origGetExts = proto.getSupportedExtensions;
        
        proto.getParameter = function(param) {
          if (param === 37445) return 'ARM';
          if (param === 37446) return 'Mali-G52 MC2';
          if (param === 7936) return 'WebKit';
          if (param === 7937) return 'WebKit WebGL';
          if (param === 7938) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
          if (param === 35724) return 'WebGL GLSL ES 1.0';
          if (param === 7939) return WEBGL_EXTENSIONS;
          if (param === 3379) return 8192;  // MAX_TEXTURE_SIZE
          if (param === 3386) return new Int32Array([8192, 8192]); // MAX_VIEWPORT_DIMS
          return origGetParam.call(this, param);
        };
        
        proto.getSupportedExtensions = () => WEBGL_EXTENSIONS.slice();
        proto.getExtension = function(name) {
          return WEBGL_EXTENSIONS.includes(name) ? {} : null;
        };
      };
      
      if (window.WebGLRenderingContext) patchWebGL(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchWebGL(WebGL2RenderingContext.prototype);
      // ============ 5. AUDIO FINGERPRINT ============
      const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
      if (OrigAudioContext) {
        const PatchedAudioContext = function(...args) {
          const ctx = new OrigAudioContext(...args);
          try {
            Object.defineProperty(ctx, 'sampleRate', { get: () => ${audioSampleRate} });
            Object.defineProperty(ctx, 'baseLatency', { get: () => ${audioBaseLatency} });
          } catch(e) {}
          return ctx;
        };
        PatchedAudioContext.prototype = OrigAudioContext.prototype;
        window.AudioContext = window.webkitAudioContext = PatchedAudioContext;
      }
      // ============ 6. WEBRTC БЛОКИРОВКА ============
      if (window.RTCPeerConnection) {
        window.RTCPeerConnection = function() {
          return {
            createDataChannel: () => ({}),
            createOffer: () => Promise.resolve({}),
            setLocalDescription: () => Promise.resolve(),
            close: () => {},
            onicecandidate: null
          };
        };
      }
      // ============ 7. MEDIA QUERIES ============
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = function(query) {
        const overrides = {
          '(pointer: coarse)': true,
          '(pointer: fine)': false,
          '(any-pointer: coarse)': true,
          '(hover: none)': true,
          '(hover: hover)': false,
          '(prefers-color-scheme: light)': true,
          '(prefers-reduced-motion: no-preference)': true
        };
        if (query in overrides) {
          return {
            matches: overrides[query], media: query, onchange: null,
            addListener: () => {}, removeListener: () => {},
            addEventListener: () => {}, removeEventListener: () => {}
          };
        }
        return originalMatchMedia.call(window, query);
      };
      // ============ 8. PERMISSIONS ============
      if (navigator.permissions) {
        navigator.permissions.query = async function(desc) {
          const denied = ['notifications', 'push'];
          const state = denied.includes(desc.name) ? 'denied' : 'prompt';
          return { state, onchange: null, addEventListener: () => {}, removeEventListener: () => {} };
        };
      }
      // ============ 9. УДАЛЕНИЕ СЛЕДОВ АВТОМАТИЗАЦИИ ============
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      
      if (window.chrome) delete window.chrome;
      Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true });
      
      // ============ 10. PERFORMANCE.MEMORY ============
      try {
        Object.defineProperty(performance, 'memory', { get: () => undefined });
      } catch(e) {}
      // ============ 11. CONNECTION ============
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'type', { get: () => '4g' });
        Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
        Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
        Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
      }
      // ============ 12. GAMEPADS ============
      navigator.getGamepads = () => [];
      // ============ 13. TOUCH ============
      window.ontouchstart = null;
      document.ontouchstart = null;
      // ============ 14. NOTIFICATION ============
      if (window.Notification) {
        Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      }
      console.log('✅ Browser spoof injected | SEED=' + SEED.toFixed(2));
    })();
  `;
}