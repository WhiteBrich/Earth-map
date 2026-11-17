/* ============================================================================
   中国自然地理图鉴 · 互动地图主程序
   ----------------------------------------------------------------------------
   代码分区：
     00. 配置与全局状态        01. 启动与错误处理
     02. Cesium 三维地球        03. 天地图三套底图
     04. 相机、滚轮、指南针      05. 鼠标经纬度与比例尺
     06. 专题图层绘制           07. 图例
     08. 知识卡片与拾取         09. 侧栏 / 底图面板 / 快捷键
     10. 启动收尾与调试接口
   ========================================================================== */

(function () {
  'use strict';

  /* ==========================================================================
     00. 配置与全局状态
     ========================================================================== */

  var META = window.CHINA_ATLAS_META;
  var GEO = window.CHINA_ATLAS_GEO;

  // 天地图浏览器端密钥。若更换密钥，只改这一处。
  var CONFIG = {
    TIANDITU_KEY: '67202ad0231a8193b8cdda3816077687',

    // 初始视野：大致覆盖中国全境；可微调这组经纬度来改变“打开就看到的中国”。
    INITIAL_RECT: { west: 72.8, south: 16.4, east: 136.0, north: 54.6 },

    // 相机高度限制：下限防止钻入底图，上限防止飞得过远。
    MIN_CAMERA_HEIGHT: 6500,
    MAX_CAMERA_HEIGHT: 16000000,

    // 固定按钮缩放倍率。每次点击 ± 这个倍率，而不是无限加速。
    ZOOM_BUTTON_FACTOR: 1.55,

    // 滚轮灵敏度。数值越小越慢；0.0006 约等于鼠标滚轮一格缩放 6%。
    WHEEL_ZOOM_RATE: 0.0006,

    // 底图最大缩放级别（天地图 WMTS 通常支持到 18 级）。
    TILE_MAX_LEVEL: 18,

    // 初始专题：打开网页时默认显示三级阶梯。
    DEFAULT_THEME: 'steps',

    // 默认底图：vector / imagery / terrain
    DEFAULT_BASE: 'vector',

    // 多专题叠加模式：可以同时开启多个专题，图例会按专题逐项排列。
    // 若希望保持“开启新专题即收起旧专题”的单专题模式，可改为 false。
    ENABLE_MULTI_THEME: true
  };

  var BASEMAP_DEFS = {
    vector: {
      name: '矢量底图',
      base: 'vec',
      labels: 'cva',
      short: '省界 · 地名 · 道路'
    },
    imagery: {
      name: '遥感底图',
      base: 'img',
      labels: 'cia',
      short: '卫星影像 · 地表纹理'
    },
    terrain: {
      name: '地形底图',
      base: 'ter',
      labels: 'cta',
      short: '地势晕渲 · 山脉起伏'
    }
  };

  // 大地图总览时只显示这些重点山脉名，缩近后再显示其余名称，避免标签重叠。
  var MAJOR_MOUNTAINS = {
    tianshan: true,
    kunlun: true,
    himalaya: true,
    qinling: true,
    'greater-khingan': true,
    taihang: true,
    qilian: true,
    hengduan: true,
    yinshan: true,
    nanling: true,
    taiwan: true,
    changbai: true,
    altai: true
  };

  var state = {
    viewerReady: false,
    bootFinished: false,
    baseId: null,
    baseLabelsVisible: true,
    activeThemes: new Set(),
    builtThemes: {},
    baseGroups: {},
    basePanelOpen: false,
    sidebarPinned: false,
    legendCollapsed: false,
    cardFeature: null,
    cardAnchor: null,
    tilesErrorCount: 0,
    tileWarningShown: false,
    graphicsFailure: false,
    pointerPosition: null,
    lastUiAt: 0,
    lastScaleAt: 0
  };

  // 浏览器或显卡偶发丢失 WebGL 上下文时，先自动刷新一次；再次失败则给出可操作提示。
  var GRAPHICS_RETRY_KEY = 'china-atlas-graphics-retry';

  var dom = {};
  var viewer = null;
  var cesium = null;
  var sidebarCloseTimer = null;
  var toastTimer = null;
  var bootCheckTimer = null;
  var bootStartedAt = 0;
  var hintTimer = null;

  /* ==========================================================================
     01. 启动与错误处理
     ========================================================================== */

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    dom.loadingScreen = byId('loadingScreen');
    dom.loadingDetail = byId('loadingDetail');
    dom.loadingCard = document.querySelector('.loading-card');
    dom.loaderTitle = document.querySelector('.loading-card h2');
    dom.sidebarZone = byId('sidebarZone');
    dom.sidebarTab = byId('sidebarTab');
    dom.sidebar = byId('sidebar');
    dom.sidebarPin = byId('sidebarPin');
    dom.sidebarClose = byId('sidebarClose');
    dom.tabBadge = byId('tabBadge');
    dom.activeThemeCount = byId('activeThemeCount');
    dom.themeButtons = Array.prototype.slice.call(document.querySelectorAll('.theme-item'));
    dom.clearThemes = byId('clearThemes');
    dom.resetViewSidebar = byId('resetViewSidebar');
    dom.sideHoverHint = byId('sideHoverHint');
    dom.compass = byId('compass');
    dom.compassNeedle = byId('compassNeedle');
    dom.compassCounter = byId('compassCounter');
    dom.zoomIn = byId('zoomIn');
    dom.zoomOut = byId('zoomOut');
    dom.zoomScale = byId('zoomScale');
    dom.legendPanel = byId('legendPanel');
    dom.legendContent = byId('legendContent');
    dom.legendToggle = byId('legendToggle');
    dom.baseSwitcher = byId('baseSwitcher');
    dom.baseToggle = byId('baseToggle');
    dom.basePanel = byId('basePanel');
    dom.baseLabelsToggle = byId('baseLabelsToggle');
    dom.baseLabelsName = byId('baseLabelsName');
    dom.baseLabelsDesc = byId('baseLabelsDesc');
    dom.baseOptions = Array.prototype.slice.call(document.querySelectorAll('.base-option'));
    dom.coordLon = byId('coordLon');
    dom.coordLat = byId('coordLat');
    dom.scaleLine = byId('scaleLine');
    dom.scaleText = byId('scaleText');
    dom.featureCard = byId('featureCard');
    dom.cardClose = byId('cardClose');
    dom.cardEyebrow = byId('cardEyebrow');
    dom.cardTitle = byId('cardTitle');
    dom.cardLead = byId('cardLead');
    dom.cardHighlight = byId('cardHighlight');
    dom.cardFacts = byId('cardFacts');
    dom.cardNoteWrap = byId('cardNoteWrap');
    dom.cardNote = byId('cardNote');
    dom.toast = byId('toast');
    dom.protocolWarning = byId('protocolWarning');
    dom.protocolWarningClose = byId('protocolWarningClose');
    dom.cesiumCredits = byId('cesiumCredits');
  }

  function setLoadingDetail(text) {
    if (dom.loadingDetail) dom.loadingDetail.textContent = text;
  }

  function failBoot(message) {
    if (!dom.loadingScreen) return;
    dom.loadingScreen.classList.add('is-error');
    if (dom.loaderTitle) dom.loaderTitle.textContent = '地图未能打开';
    setLoadingDetail(message);

    if (dom.loadingCard && !dom.loadingCard.querySelector('.boot-error')) {
      var box = document.createElement('div');
      box.className = 'boot-error';
      box.textContent =
        '排查建议：\n' +
        '1. 请通过“启动地图.bat”或本地 HTTP 服务打开本页；\n' +
        '2. 确认网络能访问 t0.tianditu.gov.cn；\n' +
        '3. 确认 vendor/cesium 目录完整；\n' +
        '4. 更换现代浏览器并确认已开启硬件加速。';
      dom.loadingCard.appendChild(box);

      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'side-btn';
      retry.style.marginTop = '12px';
      retry.textContent = '重新加载页面';
      retry.addEventListener('click', function () { window.location.reload(); });
      dom.loadingCard.appendChild(retry);
    }
  }

  function webglAvailable() {
    try {
      var canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
    } catch (error) {
      return false;
    }
  }

  function bindEarlyUi() {
    if (dom.protocolWarningClose) {
      dom.protocolWarningClose.addEventListener('click', function () {
        dom.protocolWarning.hidden = true;
      });
    }
    if (dom.cardClose) {
      dom.cardClose.addEventListener('click', closeFeatureCard);
    }
    if (location.protocol === 'file:' && dom.protocolWarning) {
      dom.protocolWarning.hidden = false;
    }
  }

  function boot() {
    cacheDom();
    bindEarlyUi();

    if (!META || !GEO) {
      failBoot('专题数据未加载。请检查 assets/thematic-meta.js 和 assets/thematic-data.js 是否存在。');
      return;
    }
    if (!window.Cesium) {
      failBoot('Cesium 三维引擎未加载。请检查 vendor/cesium/Cesium.js 是否存在。');
      return;
    }
    if (!webglAvailable()) {
      failBoot('当前浏览器未启用 WebGL，无法显示三维地图。请开启浏览器硬件加速，或换用最新版 Chrome / Edge。');
      return;
    }

    cesium = window.Cesium;
    bootStartedAt = performance.now();
    setLoadingDetail('正在初始化三维地球 ...');

    try {
      viewer = createViewer();
      if (!viewer) throw new Error('Viewer 初始化失败');

      configureViewer();
      setupBaseLayers();
      setupCameraInteractions();
      setupFrameUpdates();
      setupMapInteractions();
      bindUiEvents();

      setInitialView(true);
      setThemeActive(CONFIG.DEFAULT_THEME, true, true);
      syncThemeUi();
      renderLegend();
      exposeDebugApi();

      setLoadingDetail('正在加载天地图底图与专题图层 ...');
      startBootWatcher();
      startHintWatcher();
    } catch (error) {
      console.error('[中国地理互动地图] 初始化失败：', error);
      failBoot('三维地图初始化失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  /* ==========================================================================
     02. Cesium 三维地球
     ========================================================================== */

  function createViewer() {
    return new cesium.Viewer('cesiumContainer', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
      shouldAnimate: false,
      creditContainer: dom.cesiumCredits,
      contextOptions: {
        webgl: {
          alpha: false,
          antialias: true
        }
      }
    });
  }

  function configureViewer() {
    var scene = viewer.scene;
    var globe = scene.globe;
    var ssc = scene.screenSpaceCameraController;

    // 页面只显示三维地球，不启用时间轴、底图选择器等 Cesium 默认控件。
    // 具体底图由下方 setupBaseLayers() 管理。

    // 海面特效、地面大气、天空雾效一律关闭：地图更清晰，也满足“不启用 Cesium 海洋特效”的要求。
    if ('showWaterEffect' in globe) globe.showWaterEffect = false;
    globe.showGroundAtmosphere = false;
    globe.enableLighting = false;
    globe.depthTestAgainstTerrain = false;
    scene.skyAtmosphere.show = false;
    scene.fog.enabled = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.skyBox) scene.skyBox.show = false;

    scene.backgroundColor = cesium.Color.fromCssColorString('#061018');
    globe.baseColor = cesium.Color.fromCssColorString('#0a2030');
    globe.maximumScreenSpaceError = 1.35;
    globe.tileCacheSize = 180;

    // 说明：这里不启用额外的后处理/FXAA 着色器，以降低低端显卡上的着色器失败概率。
    // 抗锯齿由 WebGL context 的 antialias 选项负责。

    // 相机与滚轮：
    // 1) 取消 Cesium 默认的“滚轮缩放”，由下方自定义缓慢倍率滚轮代替；
    // 2) 保留双指捏合；
    // 3) 限制最近和最远距离，防止镜头穿入地面或飞到地球之外。
    try {
      ssc.zoomEventTypes = [cesium.CameraEventType.PINCH];
    } catch (error) {
      console.warn('无法自定义 Cesium 滚轮事件类型', error);
    }
    ssc.minimumZoomDistance = CONFIG.MIN_CAMERA_HEIGHT;
    ssc.maximumZoomDistance = CONFIG.MAX_CAMERA_HEIGHT;
    ssc.enableCollisionDetection = true;
    ssc.inertiaZoom = 0.45;

    if (window.devicePixelRatio && window.devicePixelRatio > 1) {
      viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.4);
    }

    installGraphicsRecovery();
    state.viewerReady = true;
  }

  function installGraphicsRecovery() {
    if (!viewer || !viewer.scene) return;

    viewer.scene.canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      handleGraphicsFailure('WebGL context lost');
    });

    if (viewer.scene.renderError) {
      viewer.scene.renderError.addEventListener(function (scene, error) {
        handleGraphicsFailure(error);
      });
    }
  }

  function readGraphicsRetryFlag() {
    try { return sessionStorage.getItem(GRAPHICS_RETRY_KEY) === '1'; } catch (error) { return false; }
  }

  function setGraphicsRetryFlag(value) {
    try {
      if (value) sessionStorage.setItem(GRAPHICS_RETRY_KEY, '1');
      else sessionStorage.removeItem(GRAPHICS_RETRY_KEY);
    } catch (error) { /* 无痕模式或 file:// 也可能禁用存储，忽略即可 */ }
  }

  function showRecoveryScreen(title, detail) {
    if (hintTimer) clearTimeout(hintTimer);
    if (!dom.loadingScreen) return;
    dom.loadingScreen.hidden = false;
    dom.loadingScreen.classList.remove('is-hidden');
    dom.loadingScreen.classList.add('is-error');
    if (dom.loaderTitle) dom.loaderTitle.textContent = title;
    setLoadingDetail(detail);
  }

  function handleGraphicsFailure(error) {
    if (state.graphicsFailure) return;
    state.graphicsFailure = true;
    clearInterval(bootCheckTimer);
    console.error('[中国地理互动地图] 图形上下文异常：', error);

    var alreadyRetried = readGraphicsRetryFlag();
    if (!alreadyRetried) {
      setGraphicsRetryFlag(true);
      showRecoveryScreen('正在恢复图形显示', '显卡上下文暂时中断，页面将在约 1 秒后自动重新加载 ...');
      setTimeout(function () { window.location.reload(); }, 1200);
      return;
    }

    showRecoveryScreen('图形显示未能恢复', '浏览器连续两次未完成 WebGL 渲染。请关闭其他占用显卡的网页，或重启浏览器后再次打开地图。');
    failBoot('图形上下文已中断。建议关闭其他三维网页 / 重启浏览器，或更新显卡驱动后再试。');
  }

  /* ==========================================================================
     03. 天地图三套底图
     ========================================================================== */

  function createTiandituProvider(layerName) {
    var provider = new cesium.WebMapTileServiceImageryProvider({
      url: 'https://t{s}.tianditu.gov.cn/' + layerName + '_w/wmts?tk=' + CONFIG.TIANDITU_KEY,
      layer: layerName,
      style: 'default',
      format: 'tiles',
      tileMatrixSetID: 'w',
      // 天地图 *_w 图层使用 Web Mercator 切片矩阵，必须与 Cesium 的投影一致。
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
      maximumLevel: CONFIG.TILE_MAX_LEVEL,
      credit: new cesium.Credit('天地图 · 自然资源部')
    });

    // 底图请求失败时，做一个不打扰的提示；文件协议或来源校验失败通常为 401/403。
    provider.errorEvent.addEventListener(function (error) {
      var code = error && (error.statusCode || error.code);
      if (code === 401 || code === 403) {
        state.tilesErrorCount += 1;
        if (state.tilesErrorCount >= 2 && !state.tileWarningShown) {
          state.tileWarningShown = true;
          showProtocolWarning();
          showToast('天地图底图请求被拒绝，请使用启动脚本通过本地服务打开。', 6200);
        }
      }
    });

    return provider;
  }

  function setupBaseLayers() {
    Object.keys(BASEMAP_DEFS).forEach(function (key) {
      var def = BASEMAP_DEFS[key];
      var baseProvider = createTiandituProvider(def.base);
      var labelProvider = createTiandituProvider(def.labels);
      var baseLayer = viewer.imageryLayers.addImageryProvider(baseProvider);
      var labelLayer = viewer.imageryLayers.addImageryProvider(labelProvider);
      baseLayer.show = false;
      labelLayer.show = false;
      state.baseGroups[key] = [baseLayer, labelLayer];
    });

    setBase(CONFIG.DEFAULT_BASE, true);
  }

  function applyBaseLayerVisibility() {
    Object.keys(state.baseGroups).forEach(function (key) {
      var layers = state.baseGroups[key];
      var isCurrent = key === state.baseId;
      if (layers[0]) layers[0].show = isCurrent;
      if (layers[1]) layers[1].show = isCurrent && state.baseLabelsVisible;
    });
  }

  function updateBaseLabelsUi() {
    if (!dom.baseLabelsToggle || !dom.baseLabelsName || !dom.baseLabelsDesc) return;
    var baseId = state.baseId || CONFIG.DEFAULT_BASE;
    var name = baseId === 'imagery' ? '影像注记' : baseId === 'terrain' ? '地形注记' : '矢量注记';
    var desc = baseId === 'imagery'
      ? '显示天地图影像地名 / 境界'
      : baseId === 'terrain' ? '显示天地图地形地名 / 境界' : '显示天地图矢量地名 / 境界';
    dom.baseLabelsName.textContent = name;
    dom.baseLabelsDesc.textContent = desc;
    dom.baseLabelsToggle.setAttribute('aria-checked', state.baseLabelsVisible ? 'true' : 'false');
    dom.baseLabelsToggle.title = (state.baseLabelsVisible ? '关闭' : '开启') + name;
  }

  function setBaseLabelsVisible(visible, silent) {
    state.baseLabelsVisible = !!visible;
    applyBaseLayerVisibility();
    updateBaseLabelsUi();
    if (!silent) {
      showToast((state.baseLabelsVisible ? '已开启「' : '已关闭「') +
        (dom.baseLabelsName ? dom.baseLabelsName.textContent : '底图注记') + '」');
    }
  }

  function setBase(baseId, silent) {
    if (!BASEMAP_DEFS[baseId]) return;

    state.baseId = baseId;
    applyBaseLayerVisibility();
    updateBaseLabelsUi();
    dom.baseOptions.forEach(function (button) {
      var active = button.getAttribute('data-base') === baseId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    dom.baseToggle.title = '切换底图（当前：' + BASEMAP_DEFS[baseId].name + '）';
    dom.baseToggle.setAttribute('aria-label', dom.baseToggle.title);
    closeBasePanel();

    if (!silent) {
      showToast('已切换到「' + BASEMAP_DEFS[baseId].name + '」');
    }
  }

  /* ==========================================================================
     04. 相机、滚轮、指南针
     ========================================================================== */

  function setInitialView(immediate) {
    var rect = cesium.Rectangle.fromDegrees(
      CONFIG.INITIAL_RECT.west,
      CONFIG.INITIAL_RECT.south,
      CONFIG.INITIAL_RECT.east,
      CONFIG.INITIAL_RECT.north
    );

    if (immediate) {
      viewer.camera.setView({ destination: rect });
    } else {
      viewer.camera.cancelFlight();
      viewer.camera.flyTo({
        destination: rect,
        duration: 1.35
      });
    }
  }

  function resetView(silent) {
    closeFeatureCard();
    setInitialView(false);
    if (!silent) showToast('已回到中国全国视角');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function applyZoom(factor) {
    if (!viewer || !isFinite(factor) || factor <= 0) return;
    var camera = viewer.camera;
    camera.cancelFlight();

    var height = camera.positionCartographic.height;
    var targetHeight = clamp(height * factor, CONFIG.MIN_CAMERA_HEIGHT, CONFIG.MAX_CAMERA_HEIGHT);
    var delta = height - targetHeight;
    if (Math.abs(delta) < 0.8) return;

    if (delta > 0) {
      camera.zoomIn(delta);
    } else {
      camera.zoomOut(-delta);
    }

    var after = camera.positionCartographic;
    if (after.height < CONFIG.MIN_CAMERA_HEIGHT) {
      camera.setView({
        destination: cesium.Cartesian3.fromRadians(after.longitude, after.latitude, CONFIG.MIN_CAMERA_HEIGHT),
        orientation: {
          heading: camera.heading,
          pitch: camera.pitch,
          roll: 0
        }
      });
    } else if (after.height > CONFIG.MAX_CAMERA_HEIGHT) {
      camera.setView({
        destination: cesium.Cartesian3.fromRadians(after.longitude, after.latitude, CONFIG.MAX_CAMERA_HEIGHT),
        orientation: {
          heading: camera.heading,
          pitch: camera.pitch,
          roll: 0
        }
      });
    }

    updateZoomReadout();
    updatePointerReadout();
  }

  function setupCameraInteractions() {
    var canvas = viewer.scene.canvas;

    // 自定义滚轮缩放。主动移除 Cesium 的 WHEEL 缩放事件类型后，
    // 这里就可以自由决定缩放速度，而不会与引擎内部缩放叠加。
    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      event.stopPropagation();

      var delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      delta = clamp(delta, -260, 260);
      if (!delta) return;

      var factor = Math.exp(delta * CONFIG.WHEEL_ZOOM_RATE);
      applyZoom(factor);
    }, { passive: false });

    dom.zoomIn.addEventListener('click', function () {
      applyZoom(1 / CONFIG.ZOOM_BUTTON_FACTOR);
    });
    dom.zoomOut.addEventListener('click', function () {
      applyZoom(CONFIG.ZOOM_BUTTON_FACTOR);
    });

    dom.compass.addEventListener('click', function () {
      var camera = viewer.camera;
      var heading = Math.abs(normalizeHeading(cesium.Math.toDegrees(camera.heading)));
      if (heading < 1.5) {
        showToast('当前视角已经朝向正北');
        return;
      }
      camera.cancelFlight();
      camera.flyTo({
        destination: cesium.Cartesian3.clone(camera.positionWC),
        orientation: {
          heading: 0,
          pitch: camera.pitch,
          roll: 0
        },
        duration: 0.7
      });
    });
  }

  function normalizeHeading(deg) {
    var value = deg % 360;
    if (value > 180) value -= 360;
    if (value < -180) value += 360;
    return value;
  }

  function updateCompass() {
    if (!viewer || !dom.compassNeedle) return;
    var camera = viewer.camera;
    var headingDeg = cesium.Math.toDegrees(camera.heading);
    dom.compassNeedle.style.transform = 'rotate(' + (-headingDeg).toFixed(1) + 'deg)';
    var normalized = headingDeg % 360;
    if (normalized < 0) normalized += 360;
    dom.compassCounter.textContent = '方位 ' + Math.round(normalized) + '°';
  }

  function updateZoomReadout() {
    if (!viewer || !dom.zoomScale) return;
    var height = viewer.camera.positionCartographic.height;
    var text = height >= 1000
      ? Math.round(height / 1000) + ' km'
      : Math.max(1, Math.round(height)) + ' m';
    dom.zoomScale.textContent = text;
    dom.zoomIn.disabled = height <= CONFIG.MIN_CAMERA_HEIGHT + 10;
    dom.zoomOut.disabled = height >= CONFIG.MAX_CAMERA_HEIGHT - 10;
  }

  /* ==========================================================================
     05. 鼠标经纬度与比例尺
     ========================================================================== */

  function pickGlobe(position) {
    if (!viewer || !position) return null;
    var scene = viewer.scene;
    var ray = viewer.camera.getPickRay(position);
    if (!ray) return null;

    var picked = scene.globe.pick(ray, scene);
    if (picked) return picked;
    return viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
  }

  function formatHemisphere(value, isLon) {
    var hemisphere = isLon
      ? (value >= 0 ? 'E' : 'W')
      : (value >= 0 ? 'N' : 'S');
    return Math.abs(value).toFixed(3) + '° ' + hemisphere;
  }

  function updatePointerReadout() {
    if (!viewer) return;
    if (!state.pointerPosition) {
      dom.coordLon.textContent = '经度 —';
      dom.coordLat.textContent = '纬度 —';
      return;
    }
    var cartesian = pickGlobe(state.pointerPosition);
    if (!cartesian) {
      dom.coordLon.textContent = '经度 —';
      dom.coordLat.textContent = '纬度 —';
      return;
    }
    var cartographic = cesium.Cartographic.fromCartesian(cartesian);
    var lon = cesium.Math.toDegrees(cartographic.longitude);
    var lat = cesium.Math.toDegrees(cartographic.latitude);
    dom.coordLon.textContent = '经度 ' + formatHemisphere(lon, true);
    dom.coordLat.textContent = '纬度 ' + formatHemisphere(lat, false);
  }

  function chooseNiceDistance(maxMeters) {
    if (!isFinite(maxMeters) || maxMeters <= 0) return 1;
    var exponent = Math.floor(Math.log(maxMeters) / Math.LN10);
    var base = maxMeters / Math.pow(10, exponent);
    var niceBase = base >= 5 ? 5 : base >= 2 ? 2 : 1;
    return niceBase * Math.pow(10, exponent);
  }

  function formatScale(meters) {
    if (meters >= 1000) {
      var km = meters / 1000;
      var text = km >= 10 ? String(Math.round(km)) : km.toFixed(1).replace(/\.0$/, '');
      return text + ' km';
    }
    return Math.round(meters) + ' m';
  }

  function updateScaleBar() {
    if (!viewer || !dom.scaleLine || !dom.scaleText) return;
    var scene = viewer.scene;
    var canvas = scene.canvas;
    var y = canvas.clientHeight * 0.55;
    var p1 = pickGlobe(new cesium.Cartesian2(canvas.clientWidth / 2 - 50, y));
    var p2 = pickGlobe(new cesium.Cartesian2(canvas.clientWidth / 2 + 50, y));

    if (!p1 || !p2) {
      dom.scaleText.textContent = '—';
      dom.scaleLine.style.width = '0px';
      return;
    }

    var c1 = cesium.Cartographic.fromCartesian(p1);
    var c2 = cesium.Cartographic.fromCartesian(p2);
    var geodesic = new cesium.EllipsoidGeodesic(c1, c2);
    var metersPer100px = geodesic.surfaceDistance;
    if (!isFinite(metersPer100px) || metersPer100px <= 0) return;

    var barMeters = chooseNiceDistance(metersPer100px * 0.8);
    var widthPx = clamp((barMeters / metersPer100px) * 100, 18, 100);
    dom.scaleLine.style.width = Math.round(widthPx) + 'px';
    dom.scaleText.textContent = formatScale(barMeters);
  }

  function setupFrameUpdates() {
    var lastCompass = 0;
    var lastScale = 0;

    viewer.scene.postRender.addEventListener(function () {
      var now = performance.now();
      if (now - lastCompass < 80) return;
      lastCompass = now;
      updateCompass();
      updateZoomReadout();

      if (now - lastScale > 260) {
        lastScale = now;
        updateScaleBar();
      }
    });

    viewer.camera.moveEnd.addEventListener(function () {
      updatePointerReadout();
      updateScaleBar();
      updateZoomReadout();
      updateCompass();
    });
  }

  /* ==========================================================================
     06. 专题图层绘制
     ========================================================================== */

  function colorFromCss(value, alpha) {
    var color = cesium.Color.fromCssColorString(value || '#8fd3b6');
    return typeof alpha === 'number' ? color.withAlpha(alpha) : color;
  }

  function polygonHierarchyFromRings(rings) {
    if (!rings || !rings.length) return null;
    var outer = [];
    rings[0].forEach(function (point) {
      outer.push(point[0], point[1]);
    });
    if (outer.length < 6) return null;

    var holes = [];
    for (var i = 1; i < rings.length; i += 1) {
      var source = rings[i];
      var hole = [];
      for (var j = 0; j < source.length; j += 1) {
        hole.push(source[j][0], source[j][1]);
      }
      if (hole.length >= 6) {
        holes.push(new cesium.PolygonHierarchy(cesium.Cartesian3.fromDegreesArray(hole)));
      }
    }
    return new cesium.PolygonHierarchy(cesium.Cartesian3.fromDegreesArray(outer), holes);
  }

  function linePositions(ring, height) {
    var values = [];
    for (var i = 0; i < ring.length; i += 1) {
      values.push(ring[i][0], ring[i][1], height);
    }
    return cesium.Cartesian3.fromDegreesArrayHeights(values);
  }

  function attachFeature(entity, info) {
    if (entity) entity.__atlasFeature = info;
    return entity;
  }

  function makeRegionInfo(theme, regionId, config) {
    return {
      themeId: theme.id,
      featureId: regionId,
      accent: config.color || theme.accent,
      tag: config.tag || theme.name,
      title: config.name,
      lead: config.lead || '',
      highlight: config.highlight || '',
      facts: config.facts || [],
      note: config.note || ''
    };
  }

  function makeBoundaryInfo(theme, boundary) {
    return {
      themeId: theme.id,
      featureId: boundary.id,
      accent: boundary.color || theme.accent,
      tag: boundary.tag || (theme.name + ' · 分界线'),
      title: boundary.name,
      lead: boundary.lead || '',
      highlight: boundary.highlight || '',
      facts: boundary.facts || [],
      note: boundary.note || ''
    };
  }

  function makeMountainInfo(theme, item) {
    return {
      themeId: theme.id,
      featureId: item.id,
      accent: item.color,
      tag: '主要山脉 · ' + item.directionName,
      title: item.name,
      lead: item.lead || '',
      highlight: item.highlight || '',
      facts: item.facts || [],
      note: item.note || ''
    };
  }

  function labelGraphics(text, options) {
    options = options || {};
    var label = {
      text: text,
      font: options.font || '600 12px "Microsoft YaHei", sans-serif',
      fillColor: options.fillColor || cesium.Color.WHITE,
      outlineColor: cesium.Color.fromCssColorString('#041219').withAlpha(0.96),
      outlineWidth: 3.5,
      style: cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: options.backgroundColor || cesium.Color.fromCssColorString('#071921').withAlpha(0.78),
      backgroundPadding: new cesium.Cartesian2(options.paddingX || 8, options.paddingY || 4),
      horizontalOrigin: cesium.HorizontalOrigin.CENTER,
      verticalOrigin: cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: 12000000,
      scaleByDistance: new cesium.NearFarScalar(80000, 1.08, 12000000, 0.84),
      translucencyByDistance: new cesium.NearFarScalar(12000000, 1.0, 24000000, 0.0)
    };
    if (options.distanceDisplayCondition) {
      label.distanceDisplayCondition = options.distanceDisplayCondition;
    }
    return label;
  }

  function addLabel(position, text, options, info) {
    if (!position) return null;
    var entity = viewer.entities.add({
      position: cesium.Cartesian3.fromDegrees(position[0], position[1], 0),
      label: labelGraphics(text, options)
    });
    if (info) attachFeature(entity, info);
    return entity;
  }

  function buildRegionTheme(themeName) {
    var theme = META.themes[themeName];
    var dataGroup = GEO.groups[themeName] || {};
    var entities = [];
    var regionIds = Object.keys(dataGroup);

    regionIds.forEach(function (regionId) {
      var config = theme.regions[regionId];
      if (!config) return;

      var info = makeRegionInfo(theme, regionId, config);
      var color = config.color || theme.accent;
      var fillAlpha = typeof config.opacity === 'number' ? config.opacity : theme.fillAlpha;
      // 多专题叠加时，不同专题使用逐级抬升的绘制高度，避免共面闪烁；
      // 地形区内部再按高原 < 平原 < 盆地错开，柴达木等嵌套盆地可覆盖在高原之上。
      var themeIndex = META.themeOrder.indexOf(themeName);
      var height = 16 + (themeIndex < 0 ? 0 : themeIndex) * 16;
      if (themeName === 'landforms') {
        height += config.kind === 'basin' ? 6 : config.kind === 'plain' ? 3 : 0;
      }

      var polygons = dataGroup[regionId] || [];
      polygons.forEach(function (polygon) {
        if (!polygon || !polygon.length) return;
        var hierarchy = polygonHierarchyFromRings(polygon);
        if (!hierarchy) return;

        var fill = viewer.entities.add({
          polygon: {
            hierarchy: hierarchy,
            height: height,
            material: colorFromCss(color, fillAlpha),
            arcType: cesium.ArcType.GEODESIC
          }
        });
        attachFeature(fill, info);
        entities.push(fill);

        // Cesium 的 polygon.outline 在部分平台宽度受限，这里用贴地折线单独描边。
        var outlineHeight = height + 4;
        polygon.forEach(function (ring) {
          if (!ring || ring.length < 3) return;
          var outline = viewer.entities.add({
            polyline: {
              positions: linePositions(ring, outlineHeight),
              width: 1.15,
              material: cesium.Color.WHITE.withAlpha(0.34),
              arcType: cesium.ArcType.GEODESIC
            }
          });
          attachFeature(outline, info);
          entities.push(outline);
        });
      });

      var labelPositions = [];
      if (config.labelPos) labelPositions.push(config.labelPos);
      if (Array.isArray(config.extraLabels)) labelPositions = labelPositions.concat(config.extraLabels);

      labelPositions.forEach(function (labelPos) {
        var labelColor = themeName === 'drywet' ? '#f2f7eb' : '#ffffff';
        var label = addLabel(labelPos, config.name, {
          font: theme.labelFont,
          fillColor: colorFromCss(labelColor, 1),
          backgroundColor: themeName === 'drywet'
            ? colorFromCss('#1d2b25', 0.84)
            : colorFromCss(color, 0.80),
          paddingX: 9,
          paddingY: 5
        }, info);
        if (label) entities.push(label);
      });
    });

    if (theme.boundaries && theme.boundaries.length) {
      theme.boundaries.forEach(function (boundary) {
        var info = makeBoundaryInfo(theme, boundary);
        var color = boundary.color || theme.accent;
        var basePositions = [];
        boundary.coords.forEach(function (point) {
          basePositions.push(point[0], point[1], 300);
        });

        // 较宽的半透明底线：提高虚线的可读性，同时方便点击拾取。
        var glow = viewer.entities.add({
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArrayHeights(basePositions),
            width: 7,
            material: colorFromCss(color, 0.16),
            arcType: cesium.ArcType.GEODESIC
          }
        });
        attachFeature(glow, info);
        entities.push(glow);

        var line = viewer.entities.add({
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArrayHeights(basePositions),
            width: 3,
            material: new cesium.PolylineDashMaterialProperty({
              color: colorFromCss(color, 0.98),
              dashLength: 18
            }),
            arcType: cesium.ArcType.GEODESIC
          }
        });
        attachFeature(line, info);
        entities.push(line);

        var hit = viewer.entities.add({
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArrayHeights(basePositions),
            width: 18,
            material: cesium.Color.WHITE.withAlpha(0.012),
            arcType: cesium.ArcType.GEODESIC
          }
        });
        attachFeature(hit, info);
        entities.push(hit);

        var label = addLabel(boundary.labelPos, boundary.label || boundary.name, {
          font: '600 10px "Microsoft YaHei", sans-serif',
          fillColor: cesium.Color.fromCssColorString('#f8e7b6'),
          backgroundColor: cesium.Color.fromCssColorString('#4e3d1d').withAlpha(0.84),
          paddingX: 7,
          paddingY: 3
        }, info);
        if (label) entities.push(label);
      });
    }

    return entities;
  }

  function buildMountainTheme(themeName) {
    var theme = META.themes[themeName];
    var entities = [];

    theme.items.forEach(function (item) {
      var info = makeMountainInfo(theme, item);
      var color = colorFromCss(item.color, 1);
      var points = [];
      item.coords.forEach(function (point) {
        points.push(point[0], point[1], 400);
      });

      var glow = viewer.entities.add({
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArrayHeights(points),
          width: 7,
          material: cesium.Color.WHITE.withAlpha(0.20),
          arcType: cesium.ArcType.GEODESIC
        }
      });
      attachFeature(glow, info);
      entities.push(glow);

      var arrowMaterial;
      if (cesium.PolylineArrowMaterialProperty) {
        arrowMaterial = new cesium.PolylineArrowMaterialProperty(color);
      } else {
        arrowMaterial = color;
      }

      var mainLine = viewer.entities.add({
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArrayHeights(points),
          width: 3,
          material: arrowMaterial,
          arcType: cesium.ArcType.GEODESIC
        }
      });
      attachFeature(mainLine, info);
      entities.push(mainLine);

      var hitLine = viewer.entities.add({
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArrayHeights(points),
          width: 16,
          material: cesium.Color.WHITE.withAlpha(0.012),
          arcType: cesium.ArcType.GEODESIC
        }
      });
      attachFeature(hitLine, info);
      entities.push(hitLine);

      var isMajor = !!MAJOR_MOUNTAINS[item.id];
      var maxDistance = isMajor ? 15000000 : 3600000;
      var label = addLabel(item.labelPos, item.name, {
        font: isMajor ? '600 11.5px "Microsoft YaHei", sans-serif' : '600 10px "Microsoft YaHei", sans-serif',
        fillColor: cesium.Color.WHITE,
        backgroundColor: color.withAlpha(0.84),
        paddingX: 8,
        paddingY: 4,
        distanceDisplayCondition: new cesium.DistanceDisplayCondition(0, maxDistance)
      }, info);
      if (label) entities.push(label);
    });

    return entities;
  }

  function buildTheme(themeName) {
    if (!META.themes[themeName]) return [];
    var entities = [];
    viewer.entities.suspendEvents();
    try {
      if (themeName === 'mountains') {
        entities = buildMountainTheme(themeName);
      } else {
        entities = buildRegionTheme(themeName);
      }
    } finally {
      viewer.entities.resumeEvents();
    }
    eventsMarkedHidden(entities);
    return entities;
  }

  function eventsMarkedHidden(entities) {
    entities.forEach(function (entity) {
      entity.show = false;
    });
  }

  function ensureThemeBuilt(themeName) {
    if (state.builtThemes[themeName]) return state.builtThemes[themeName];
    var entities = buildTheme(themeName);
    state.builtThemes[themeName] = entities;
    return entities;
  }

  function setThemeActive(themeName, active, silent) {
    if (!META.themes[themeName] || !viewer) return;

    var previousActive = Array.from(state.activeThemes);
    var entities = ensureThemeBuilt(themeName);

    // 单专题兼容模式：仅在 ENABLE_MULTI_THEME=false 时，进入新专题会隐藏旧专题。
    if (active && !CONFIG.ENABLE_MULTI_THEME) {
      Object.keys(state.builtThemes).forEach(function (name) {
        if (name === themeName) return;
        state.builtThemes[name].forEach(function (entity) {
          entity.show = false;
        });
        state.activeThemes.delete(name);
      });
    }

    entities.forEach(function (entity) {
      entity.show = !!active;
    });

    if (active) state.activeThemes.add(themeName);
    else state.activeThemes.delete(themeName);

    if (state.cardFeature) {
      if (!active && state.cardFeature.themeId === themeName) {
        closeFeatureCard();
      } else if (active && !CONFIG.ENABLE_MULTI_THEME && state.cardFeature.themeId !== themeName) {
        closeFeatureCard();
      }
    }

    syncThemeUi();
    renderLegend();
    hideSideHint();

    if (!silent) {
      var theme = META.themes[themeName];
      if (active) {
        if (CONFIG.ENABLE_MULTI_THEME && previousActive.length) {
          showToast('已叠加显示「' + theme.name + '」专题，图例已更新');
        } else {
          var switched = previousActive.some(function (name) { return name !== themeName; });
          showToast((switched && !CONFIG.ENABLE_MULTI_THEME ? '已切换至「' : '已开启「') + theme.name + '」专题，图例已更新');
        }
      } else {
        showToast('已隐藏「' + theme.name + '」专题');
      }
    }
  }

  function toggleTheme(themeName) {
    setThemeActive(themeName, !state.activeThemes.has(themeName), false);
  }

  function clearAllThemes() {
    var count = state.activeThemes.size;
    if (!count) {
      showToast('当前没有开启的专题');
      return;
    }
    Object.keys(state.builtThemes).forEach(function (themeName) {
      state.builtThemes[themeName].forEach(function (entity) {
        entity.show = false;
      });
    });
    state.activeThemes.clear();
    closeFeatureCard();
    syncThemeUi();
    renderLegend();
    showToast('已隐藏全部专题，查看纯净底图');
  }

  /* ==========================================================================
     07. 图例
     ========================================================================== */

  function createLegendSwatch(entry) {
    var swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    if (entry.type === 'line') swatch.classList.add('is-line');
    if (entry.dashed) swatch.classList.add('is-dashed');
    if (entry.arrow) swatch.classList.add('is-arrow');
    swatch.style.setProperty('--swatch', entry.color);
    if (entry.type !== 'line') swatch.style.backgroundColor = entry.color;
    return swatch;
  }

  function renderLegend() {
    if (!dom.legendContent) return;
    dom.legendContent.scrollTop = 0;
    while (dom.legendContent.firstChild) dom.legendContent.removeChild(dom.legendContent.firstChild);

    var activeList = META.themeOrder.filter(function (name) {
      return state.activeThemes.has(name);
    });

    if (!activeList.length) {
      dom.legendPanel.classList.remove('is-visible');
      dom.legendPanel.setAttribute('aria-hidden', 'true');
      return;
    }

    activeList.forEach(function (themeName) {
      var theme = META.themes[themeName];
      var section = document.createElement('section');
      section.className = 'legend-section';
      section.style.setProperty('--section-accent', theme.accent);

      var title = document.createElement('h3');
      title.className = 'legend-section-title';
      title.textContent = theme.legendTitle;
      section.appendChild(title);

      var grid = document.createElement('div');
      grid.className = 'legend-grid';

      (theme.legend || []).forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'legend-item';
        row.appendChild(createLegendSwatch(entry));

        var label = document.createElement('span');
        label.className = 'legend-label';
        label.textContent = entry.label;
        row.appendChild(label);

        var note = document.createElement('span');
        note.className = 'legend-note';
        note.textContent = entry.note || '';
        row.appendChild(note);

        grid.appendChild(row);
      });
      section.appendChild(grid);

      if (theme.tip) {
        var tip = document.createElement('p');
        tip.className = 'legend-tip';
        tip.textContent = theme.tip;
        section.appendChild(tip);
      }

      dom.legendContent.appendChild(section);
    });

    var globalTip = document.createElement('p');
    globalTip.className = 'legend-tip';
    globalTip.textContent = '点击地图上的色块、线条或名称，查看知识卡片。';
    dom.legendContent.appendChild(globalTip);

    dom.legendPanel.classList.add('is-visible');
    dom.legendPanel.setAttribute('aria-hidden', 'false');
    dom.legendPanel.classList.toggle('is-collapsed', state.legendCollapsed);
    dom.legendToggle.textContent = state.legendCollapsed ? '+' : '−';
    dom.legendToggle.setAttribute('aria-expanded', state.legendCollapsed ? 'false' : 'true');
  }

  function syncThemeUi() {
    dom.themeButtons.forEach(function (button) {
      var themeName = button.getAttribute('data-theme');
      var active = state.activeThemes.has(themeName);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    var count = state.activeThemes.size;
    dom.activeThemeCount.textContent = '已开启 ' + count + ' 个';
    dom.tabBadge.textContent = String(count);
    dom.tabBadge.hidden = count === 0;
    dom.clearThemes.disabled = count === 0;
  }

  /* ==========================================================================
     08. 知识卡片与地图拾取
     ========================================================================== */

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function openFeatureCard(info, anchor) {
    if (!info) return;
    state.cardFeature = info;
    state.cardAnchor = anchor || { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    dom.featureCard.style.setProperty('--card-accent', info.accent || '#8fd3b6');
    dom.cardEyebrow.textContent = info.tag || '地理知识';
    dom.cardTitle.textContent = info.title || '';
    dom.cardLead.textContent = info.lead || '';

    if (info.highlight) {
      dom.cardHighlight.textContent = info.highlight;
      dom.cardHighlight.hidden = false;
    } else {
      dom.cardHighlight.hidden = true;
      dom.cardHighlight.textContent = '';
    }

    clearNode(dom.cardFacts);
    (info.facts || []).forEach(function (fact) {
      var row = document.createElement('div');
      row.className = 'fact-row';
      var key = document.createElement('div');
      key.className = 'fact-key';
      key.textContent = fact[0] || '';
      var value = document.createElement('div');
      value.className = 'fact-value';
      value.textContent = fact[1] || '';
      row.appendChild(key);
      row.appendChild(value);
      dom.cardFacts.appendChild(row);
    });

    if (info.note) {
      dom.cardNote.textContent = info.note;
      dom.cardNoteWrap.hidden = false;
    } else {
      dom.cardNoteWrap.hidden = true;
    }

    dom.featureCard.classList.add('is-open');
    dom.featureCard.setAttribute('aria-hidden', 'false');
    positionFeatureCard(state.cardAnchor);
    hideSideHint();
  }

  function positionFeatureCard(anchor) {
    if (!dom.featureCard) return;

    if (window.innerWidth <= 600) {
      dom.featureCard.style.left = '';
      dom.featureCard.style.top = '';
      return;
    }

    var margin = 18;
    var cardRect = dom.featureCard.getBoundingClientRect();
    var width = Math.min(cardRect.width || 364, window.innerWidth - margin * 2);
    var height = cardRect.height || 360;
    var x = anchor && typeof anchor.x === 'number' ? anchor.x : window.innerWidth / 2;
    var y = anchor && typeof anchor.y === 'number' ? anchor.y : window.innerHeight / 2;

    var left = x + 24;
    if (left + width > window.innerWidth - margin) left = x - width - 24;
    left = clamp(left, margin, window.innerWidth - width - margin);

    var top = y - 20;
    var bottomLimit = window.innerHeight - 70;
    if (top + height > bottomLimit) top = bottomLimit - height;
    top = clamp(top, 82, Math.max(82, window.innerHeight - height - 18));

    dom.featureCard.style.left = Math.round(left) + 'px';
    dom.featureCard.style.top = Math.round(top) + 'px';
  }

  function closeFeatureCard() {
    if (!dom.featureCard) return;
    dom.featureCard.classList.remove('is-open');
    dom.featureCard.setAttribute('aria-hidden', 'true');
    state.cardFeature = null;
    state.cardAnchor = null;
  }

  function featureFromPick(position) {
    if (!viewer) return null;
    var picked = viewer.scene.pick(position);
    if (cesium.defined(picked) && picked.id && picked.id.__atlasFeature) {
      return picked.id.__atlasFeature;
    }
    return null;
  }

  function setupMapInteractions() {
    var canvas = viewer.scene.canvas;

    var handler = new cesium.ScreenSpaceEventHandler(canvas);
    handler.setInputAction(function (movement) {
      var info = featureFromPick(movement.position);
      if (info) {
        openFeatureCard(info, movement.position);
      } else {
        closeFeatureCard();
      }
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);

    canvas.addEventListener('pointermove', function (event) {
      var rect = canvas.getBoundingClientRect();
      state.pointerPosition = new cesium.Cartesian2(
        event.clientX - rect.left,
        event.clientY - rect.top
      );
      updatePointerReadout();

      // 拾取到专题要素时显示手形光标，帮助用户发现可点击区域。
      var info = featureFromPick(state.pointerPosition);
      canvas.style.cursor = info ? 'pointer' : 'grab';
    });

    canvas.addEventListener('pointerleave', function () {
      state.pointerPosition = null;
      updatePointerReadout();
      canvas.style.cursor = 'grab';
    });
  }

  function openFeatureById(themeName, featureId) {
    var theme = META.themes[themeName];
    if (!theme) return false;
    var info = null;

    if (themeName === 'mountains') {
      var mountain = theme.items.find(function (item) {
        return item.id === featureId || item.name === featureId;
      });
      if (mountain) info = makeMountainInfo(theme, mountain);
    } else {
      var regionConfig = theme.regions && theme.regions[featureId];
      if (regionConfig) info = makeRegionInfo(theme, featureId, regionConfig);
      if (!info && theme.boundaries) {
        var boundary = theme.boundaries.find(function (item) {
          return item.id === featureId;
        });
        if (boundary) info = makeBoundaryInfo(theme, boundary);
      }
    }

    if (!info) return false;
    if (!state.activeThemes.has(themeName)) setThemeActive(themeName, true, true);
    openFeatureCard(info, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    return true;
  }

  /* ==========================================================================
     09. 侧栏 / 底图面板 / 提示 / 快捷键
     ========================================================================== */

  function showToast(message, duration) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('is-visible');
    }, duration || 3200);
  }

  function showProtocolWarning() {
    if (dom.protocolWarning) dom.protocolWarning.hidden = false;
  }

  function hideSideHint() {
    if (dom.sideHoverHint) dom.sideHoverHint.classList.add('is-gone');
  }

  function startHintWatcher() {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideSideHint, 9000);
  }

  function openSidebar() {
    if (!dom.sidebarZone) return;
    dom.sidebarZone.classList.add('is-open');
    dom.sidebar.setAttribute('aria-hidden', 'false');
    hideSideHint();
    clearTimeout(sidebarCloseTimer);
  }

  function closeSidebar() {
    if (!dom.sidebarZone || state.sidebarPinned) return;
    dom.sidebarZone.classList.remove('is-open');
    if (!state.sidebarPinned) dom.sidebar.setAttribute('aria-hidden', 'true');
  }

  function scheduleSidebarClose() {
    if (state.sidebarPinned) return;
    clearTimeout(sidebarCloseTimer);
    sidebarCloseTimer = setTimeout(closeSidebar, 460);
  }

  function setSidebarPinned(pinned) {
    state.sidebarPinned = !!pinned;
    dom.sidebarZone.classList.toggle('is-pinned', state.sidebarPinned);
    dom.sidebarPin.classList.toggle('is-active', state.sidebarPinned);
    dom.sidebarPin.setAttribute('aria-pressed', state.sidebarPinned ? 'true' : 'false');
    dom.sidebarPin.title = state.sidebarPinned ? '取消固定侧栏' : '固定侧栏';

    if (state.sidebarPinned) {
      openSidebar();
    } else if (!dom.sidebarZone.matches(':hover')) {
      dom.sidebarZone.classList.remove('is-open');
      dom.sidebar.setAttribute('aria-hidden', 'true');
    }
  }

  function closeSidebarCompletely() {
    state.sidebarPinned = false;
    dom.sidebarZone.classList.remove('is-pinned');
    dom.sidebarZone.classList.remove('is-open');
    dom.sidebarPin.classList.remove('is-active');
    dom.sidebarPin.setAttribute('aria-pressed', 'false');
    dom.sidebar.setAttribute('aria-hidden', 'true');
  }

  function openBasePanel() {
    dom.basePanel.hidden = false;
    dom.baseToggle.setAttribute('aria-expanded', 'true');
    state.basePanelOpen = true;
  }

  function closeBasePanel() {
    if (!dom.basePanel) return;
    dom.basePanel.hidden = true;
    dom.baseToggle.setAttribute('aria-expanded', 'false');
    state.basePanelOpen = false;
  }

  function toggleBasePanel() {
    if (state.basePanelOpen) closeBasePanel();
    else openBasePanel();
  }

  function bindSidebarEvents() {
    var hoverCapable = window.matchMedia && window.matchMedia('(hover: hover)').matches;

    dom.sidebarTab.addEventListener('click', function () {
      setSidebarPinned(true);
      openSidebar();
    });

    dom.sidebarPin.addEventListener('click', function () {
      setSidebarPinned(!state.sidebarPinned);
    });

    dom.sidebarClose.addEventListener('click', closeSidebarCompletely);

    if (hoverCapable) {
      dom.sidebarZone.addEventListener('pointerenter', function (event) {
        if (event.pointerType === 'touch') return;
        clearTimeout(sidebarCloseTimer);
        openSidebar();
      });
      dom.sidebarZone.addEventListener('pointerleave', function () {
        scheduleSidebarClose();
      });
    }

    dom.themeButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        toggleTheme(button.getAttribute('data-theme'));
      });
    });

    dom.clearThemes.addEventListener('click', clearAllThemes);
    dom.resetViewSidebar.addEventListener('click', function () { resetView(false); });
  }

  function bindBaseEvents() {
    dom.baseToggle.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleBasePanel();
    });

    dom.baseOptions.forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        setBase(button.getAttribute('data-base'), false);
      });
    });

    if (dom.baseLabelsToggle) {
      dom.baseLabelsToggle.addEventListener('click', function (event) {
        event.stopPropagation();
        setBaseLabelsVisible(!state.baseLabelsVisible, false);
      });
    }

    document.addEventListener('pointerdown', function (event) {
      if (state.basePanelOpen && !dom.baseSwitcher.contains(event.target)) {
        closeBasePanel();
      }
    });
  }

  function bindLegendEvents() {
    dom.legendToggle.addEventListener('click', function () {
      state.legendCollapsed = !state.legendCollapsed;
      dom.legendPanel.classList.toggle('is-collapsed', state.legendCollapsed);
      dom.legendToggle.textContent = state.legendCollapsed ? '+' : '−';
      dom.legendToggle.setAttribute('aria-expanded', state.legendCollapsed ? 'false' : 'true');
    });
  }

  function bindKeyboardEvents() {
    document.addEventListener('keydown', function (event) {
      var tagName = event.target && event.target.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
      // 把 Ctrl / Cmd / Alt 组合键留给浏览器和操作系统（例如 Ctrl+1 切换标签页）。
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (state.cardFeature) {
          closeFeatureCard();
          return;
        }
        if (state.basePanelOpen) {
          closeBasePanel();
          return;
        }
        if (state.sidebarPinned || dom.sidebarZone.classList.contains('is-open')) {
          closeSidebarCompletely();
        }
        return;
      }

      if (event.key >= '1' && event.key <= '6') {
        var themeName = META.themeOrder[Number(event.key) - 1];
        if (themeName) toggleTheme(themeName);
        return;
      }
      if (event.key === '0') {
        clearAllThemes();
        return;
      }
      if (event.key.toLowerCase() === 'h') {
        resetView(false);
      }
    });
  }

  function bindUiEvents() {
    bindSidebarEvents();
    bindBaseEvents();
    bindLegendEvents();
    bindKeyboardEvents();

    window.addEventListener('resize', function () {
      if (state.cardFeature) positionFeatureCard(state.cardAnchor);
    });
  }

  /* ==========================================================================
     10. 启动收尾与调试接口
     ========================================================================== */

  function startBootWatcher() {
    var elapsedTextShown = false;
    clearInterval(bootCheckTimer);

    bootCheckTimer = setInterval(function () {
      var elapsed = performance.now() - bootStartedAt;
      var globe = viewer && viewer.scene && viewer.scene.globe;

      if (!elapsedTextShown && elapsed > 1200) {
        elapsedTextShown = true;
        setLoadingDetail('正在绘制底图与专题图层 ...');
      }

      if (!globe) {
        if (elapsed > 6000) finishBoot();
        return;
      }

      if ((elapsed > 900 && globe.tilesLoaded) || elapsed > 6200) {
        finishBoot();
      }
    }, 220);
  }

  function finishBoot() {
    if (state.bootFinished || state.graphicsFailure) return;
    state.bootFinished = true;
    clearInterval(bootCheckTimer);
    // 地图渲染成功后清除“自动恢复”标记，下一次浏览器上下文丢失仍可自动恢复一次。
    setTimeout(function () { setGraphicsRetryFlag(false); }, 1800);

    if (dom.loadingScreen) {
      dom.loadingScreen.classList.add('is-hidden');
      setTimeout(function () {
        if (dom.loadingScreen) dom.loadingScreen.hidden = true;
      }, 760);
    }

    setTimeout(function () {
      if (location.protocol === 'file:') {
        showToast('提示：双击“启动地图.bat”可获得完整底图加载体验。', 5200);
      } else {
        showToast('三级阶梯专题已开启 · 悬停左侧边缘切换更多图层', 4300);
      }
    }, 700);
  }

  function exposeDebugApi() {
    window.ChinaAtlas = {
      version: '1.0.0',
      viewer: viewer,
      setTheme: function (themeName, active) {
        setThemeActive(themeName, !!active, true);
      },
      toggleTheme: toggleTheme,
      setBase: function (baseId) { setBase(baseId, false); },
      setBaseLabels: function (visible) { setBaseLabelsVisible(!!visible, true); },
      toggleBaseLabels: function () { setBaseLabelsVisible(!state.baseLabelsVisible, false); },
      resetView: function () { resetView(false); },
      openFeature: openFeatureById,
      project: function (lon, lat) {
        if (!viewer) return null;
        var position = cesium.Cartesian3.fromDegrees(lon, lat, 0);
        var screen = viewer.scene.cartesianToCanvasCoordinates(position);
        return screen ? { x: screen.x, y: screen.y } : null;
      },
      getState: function () {
        var camera = viewer.camera;
        var carto = camera.positionCartographic;
        return {
          base: state.baseId,
          baseLabels: state.baseLabelsVisible,
          activeThemes: Array.from(state.activeThemes),
          cameraHeight: carto.height,
          heading: cesium.Math.toDegrees(camera.heading),
          pitch: cesium.Math.toDegrees(camera.pitch),
          pointer: state.pointerPosition ? { x: state.pointerPosition.x, y: state.pointerPosition.y } : null,
          card: state.cardFeature ? state.cardFeature.title : null
        };
      }
    };
  }

  /* ==========================================================================
     启动入口
     ========================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
