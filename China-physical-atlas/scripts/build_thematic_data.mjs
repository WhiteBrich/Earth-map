#!/usr/bin/env node
/* ============================================================================
 * 中国地理互动地图 · 专题区划数据生成脚本
 * ----------------------------------------------------------------------------
 * 1. 读取 data/china-provinces.geojson（省级边界）；
 * 2. 合并省界为中国轮廓，作为专题图层的裁剪范围；
 * 3. 用教学示意多边形 + 中国轮廓裁剪，生成气候、干湿、三级阶梯、温度带和地形区；
 * 4. 简化坐标、剔除微小碎块，输出 assets/thematic-data.js；
 * 5. 用关键城市和地形区关键点校验归属；校验失败时停止输出，防止错误坐标写入页面。
 *
 * 注意：这是教学示意区划，不是官方自然资源区划，也不用于权属判断。
 * 构建依赖：.build/deps/node_modules/polygon-clipping
 * 运行：node scripts/build_thematic_data.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pc = require('../.build/deps/node_modules/polygon-clipping/dist/polygon-clipping.cjs.js');

const ROOT = process.cwd();
const SOURCE_GEOJSON = path.join(ROOT, 'data', 'china-provinces.geojson');
const OUTPUT_JS = path.join(ROOT, 'assets', 'thematic-data.js');
const DEBUG_JSON = path.join(ROOT, '.build', 'thematic-geo-debug.json');

const SIMPLIFY_TOLERANCE = 0.018;
const MIN_OUTER_AREA = 0.008;
const MIN_HOLE_AREA = 0.0005;

function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [...first]];
  return ring;
}

function toClippingGeometry(geometry) {
  if (!geometry) return null;
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!polygons) return null;
  return polygons
    .filter((p) => Array.isArray(p) && p.length)
    .map((p) => p.map(closeRing));
}

function polygonFromRing(ring) {
  return [[closeRing(ring)]];
}

function unionMany(geometries) {
  const valid = geometries.filter((g) => Array.isArray(g) && g.length > 0);
  if (!valid.length) return [];
  let merged = valid[0];
  for (let i = 1; i < valid.length; i += 1) merged = pc.union(merged, valid[i]);
  return merged;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

function pointLineDistanceSq(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyRdp(points, tolerance) {
  if (points.length <= 2) return points;
  const sqTolerance = tolerance * tolerance;
  const markers = new Uint8Array(points.length);
  markers[0] = 1;
  markers[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const pair = stack.pop();
    const start = pair[0];
    const end = pair[1];
    let maxSq = 0;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = pointLineDistanceSq(points[i], points[start], points[end]);
      if (d > maxSq) { maxSq = d; index = i; }
    }
    if (maxSq > sqTolerance && index !== -1) {
      markers[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => markers[i]);
}

function normalizeRing(ring) {
  const cleaned = [];
  for (const point of ring) {
    const p = [Number(point[0].toFixed(4)), Number(point[1].toFixed(4))];
    if (!cleaned.length) { cleaned.push(p); continue; }
    const prev = cleaned[cleaned.length - 1];
    if (p[0] !== prev[0] || p[1] !== prev[1]) cleaned.push(p);
  }
  if (cleaned.length > 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) cleaned.pop();
  }
  return cleaned;
}

function cleanGeometry(geometry, tolerance = SIMPLIFY_TOLERANCE) {
  if (!geometry || !geometry.length) return [];
  const output = [];
  for (const polygon of geometry) {
    if (!polygon || !polygon.length) continue;
    const outer = normalizeRing(simplifyRdp(polygon[0], tolerance));
    if (outer.length < 3 || ringArea(closeRing(outer)) < MIN_OUTER_AREA) continue;
    const holes = [];
    for (let i = 1; i < polygon.length; i += 1) {
      const hole = normalizeRing(simplifyRdp(polygon[i], tolerance));
      if (hole.length >= 3 && ringArea(closeRing(hole)) >= MIN_HOLE_AREA) holes.push(hole);
    }
    output.push([outer, ...holes]);
  }
  return output;
}

function countCoordinates(geometry) {
  let n = 0;
  for (const polygon of geometry) for (const ring of polygon) n += ring.length;
  return n;
}

function outerArea(geometry) {
  let area = 0;
  for (const polygon of geometry) area += ringArea(closeRing(polygon[0]));
  return area;
}

// 点面关系：用于生成前的关键城市归属校验，避免“看起来差不多”但其实画反了。
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(geometry, lon, lat) {
  for (const polygon of geometry) {
    if (!polygon.length) continue;
    if (!pointInRing(lon, lat, closeRing(polygon[0]))) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i += 1) {
      if (pointInRing(lon, lat, closeRing(polygon[i]))) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function findRegion(group, lon, lat) {
  if (!group) return null;
  for (const id of Object.keys(group)) {
    if (pointInGeometry(group[id], lon, lat)) return id;
  }
  return null;
}

const ANCHOR_CHECKS = [
  { name: '漠河', lon: 122.54, lat: 52.97, temperature: 'coldTemperate' },
  { name: '哈尔滨', lon: 126.64, lat: 45.76, steps: 'step3', climate: 'temperateMonsoon', temperature: 'midTemperate' },
  { name: '沈阳', lon: 123.43, lat: 41.81, steps: 'step3', climate: 'temperateMonsoon', temperature: 'midTemperate' },
  { name: '北京', lon: 116.41, lat: 39.90, steps: 'step3', climate: 'temperateMonsoon', temperature: 'warmTemperate' },
  { name: '太原', lon: 112.55, lat: 37.87, steps: 'step2', climate: 'temperateMonsoon', temperature: 'warmTemperate' },
  { name: '石家庄', lon: 114.51, lat: 38.04, steps: 'step3', climate: 'temperateMonsoon', temperature: 'warmTemperate' },
  { name: '济南', lon: 117.12, lat: 36.65, steps: 'step3', climate: 'temperateMonsoon', temperature: 'warmTemperate' },
  { name: '西安', lon: 108.94, lat: 34.34, steps: 'step2', climate: 'temperateMonsoon', temperature: 'warmTemperate' },
  { name: '兰州', lon: 103.83, lat: 36.06, steps: 'step2', climate: 'temperateContinental', temperature: 'warmTemperate' },
  { name: '乌鲁木齐', lon: 87.62, lat: 43.83, steps: 'step2', climate: 'temperateContinental', temperature: 'midTemperate' },
  { name: '喀什', lon: 75.99, lat: 39.47, steps: 'step2', climate: 'temperateContinental', temperature: 'warmTemperate' },
  { name: '呼和浩特', lon: 111.75, lat: 40.84, steps: 'step2', temperature: 'midTemperate' },
  { name: '拉萨', lon: 91.14, lat: 29.65, steps: 'step1', climate: 'highMountain', temperature: 'plateau' },
  { name: '西宁', lon: 101.78, lat: 36.62, steps: 'step1', climate: 'highMountain', temperature: 'plateau' },
  { name: '格尔木', lon: 94.90, lat: 36.41, steps: 'step1', climate: 'highMountain', temperature: 'plateau' },
  { name: '成都', lon: 104.07, lat: 30.57, steps: 'step2', climate: 'subtropical', temperature: 'subtropical' },
  { name: '重庆', lon: 106.55, lat: 29.56, steps: 'step2', climate: 'subtropical', temperature: 'subtropical' },
  { name: '武汉', lon: 114.31, lat: 30.59, steps: 'step3', climate: 'subtropical', temperature: 'subtropical' },
  { name: '长沙', lon: 112.94, lat: 28.23, steps: 'step3', climate: 'subtropical', temperature: 'subtropical' },
  { name: '贵阳', lon: 106.63, lat: 26.65, steps: 'step2', climate: 'subtropical', temperature: 'subtropical' },
  { name: '昆明', lon: 102.83, lat: 24.88, steps: 'step2', climate: 'subtropical', temperature: 'subtropical' },
  { name: '广州', lon: 113.26, lat: 23.13, steps: 'step3', climate: 'subtropical', temperature: 'subtropical' },
  { name: '南京', lon: 118.80, lat: 32.06, steps: 'step3', climate: 'subtropical', temperature: 'subtropical' },
  { name: '上海', lon: 121.47, lat: 31.23, steps: 'step3', climate: 'subtropical', temperature: 'subtropical' },
  { name: '海口', lon: 110.20, lat: 20.04, climate: 'tropical', temperature: 'tropical' },
  { name: '景洪', lon: 100.80, lat: 22.00, steps: 'step2', climate: 'tropical', temperature: 'tropical' }
];

// 用一组稳定城市验证干湿区分布，防止把青藏高原或准噶尔盆地误归为干旱区。
const DRY_WET_ANCHOR_EXPECT = {
  '漠河': 'humid',
  '呼和浩特': 'semiAridNorth',
  '哈尔滨': 'semiHumid',
  '北京': 'semiHumid',
  '石家庄': 'semiHumid',
  '济南': 'semiHumid',
  '太原': 'semiHumid',
  '西安': 'semiHumid',
  '兰州': 'semiHumid',
  '乌鲁木齐': 'semiAridNorth',
  '喀什': 'arid',
  '拉萨': 'semiAridTibet',
  '格尔木': 'arid',
  '成都': 'humid',
  '重庆': 'humid',
  '武汉': 'humid',
  '长沙': 'humid',
  '贵阳': 'humid',
  '昆明': 'humid',
  '广州': 'humid',
  '南京': 'humid',
  '上海': 'humid',
  '海口': 'humid',
  '景洪': 'humid',
  '沈阳': 'semiHumid',
  '长春': 'semiHumid',
  '郑州': 'semiHumid'
};
ANCHOR_CHECKS.forEach(function (anchor) {
  if (DRY_WET_ANCHOR_EXPECT[anchor.name]) anchor.drywet = DRY_WET_ANCHOR_EXPECT[anchor.name];
});

// 地形区不是彼此排斥的完整分区：柴达木盆地嵌套在青藏高原内，
// 因此用 include / exclude 检查“必须落入/不得落入”的地形区集合。
const LANDFORM_CHECKS = [
  { name: '拉萨', lon: 91.14, lat: 29.65, include: ['plateau_qinghaiTibet'], exclude: ['basin_sichuan'] },
  { name: '西宁', lon: 101.78, lat: 36.62, include: ['plateau_qinghaiTibet'] },
  { name: '格尔木', lon: 94.90, lat: 36.41, include: ['plateau_qinghaiTibet', 'basin_qaidam'] },
  { name: '呼和浩特', lon: 111.75, lat: 40.84, include: ['plateau_innerMongolia'] },
  { name: '太原', lon: 112.55, lat: 37.87, include: ['plateau_loess'] },
  { name: '延安', lon: 109.49, lat: 36.59, include: ['plateau_loess'] },
  { name: '西安', lon: 108.94, lat: 34.34, include: ['plateau_loess'] },
  { name: '兰州', lon: 103.83, lat: 36.06, include: ['plateau_loess'] },
  { name: '昆明', lon: 102.83, lat: 24.88, include: ['plateau_yunnanGuizhou'] },
  { name: '贵阳', lon: 106.63, lat: 26.65, include: ['plateau_yunnanGuizhou'] },
  { name: '喀什', lon: 75.99, lat: 39.47, include: ['basin_tarim'], exclude: ['basin_junggar'] },
  { name: '和田', lon: 79.92, lat: 37.11, include: ['basin_tarim'] },
  { name: '阿克苏', lon: 80.26, lat: 41.17, include: ['basin_tarim'] },
  { name: '乌鲁木齐', lon: 87.62, lat: 43.83, include: ['basin_junggar'], exclude: ['basin_tarim'] },
  { name: '克拉玛依', lon: 84.89, lat: 45.58, include: ['basin_junggar'] },
  { name: '德令哈', lon: 97.36, lat: 37.37, include: ['basin_qaidam'] },
  { name: '成都', lon: 104.07, lat: 30.57, include: ['basin_sichuan'] },
  { name: '重庆', lon: 106.55, lat: 29.56, include: ['basin_sichuan'] },
  { name: '哈尔滨', lon: 126.64, lat: 45.76, include: ['plain_northeast'] },
  { name: '齐齐哈尔', lon: 123.92, lat: 47.34, include: ['plain_northeast'] },
  { name: '佳木斯', lon: 130.32, lat: 46.80, include: ['plain_northeast'] },
  { name: '长春', lon: 125.32, lat: 43.82, include: ['plain_northeast'] },
  { name: '沈阳', lon: 123.43, lat: 41.81, include: ['plain_northeast'] },
  { name: '北京', lon: 116.41, lat: 39.90, include: ['plain_northChina'], exclude: ['plain_northeast'] },
  { name: '石家庄', lon: 114.51, lat: 38.04, include: ['plain_northChina'] },
  { name: '济南', lon: 117.12, lat: 36.65, include: ['plain_northChina'] },
  { name: '郑州', lon: 113.63, lat: 34.75, include: ['plain_northChina'] },
  { name: '武汉', lon: 114.31, lat: 30.59, include: ['plain_yangtze'], exclude: ['plain_northChina'] },
  { name: '南京', lon: 118.80, lat: 32.06, include: ['plain_yangtze'] },
  { name: '上海', lon: 121.47, lat: 31.23, include: ['plain_yangtze'] }
];

function validateAnchors(groups) {
  console.log('[5/6] 关键城市坐标与分区归属检查 ...');
  let failed = 0;
  const details = [];
  for (const anchor of ANCHOR_CHECKS) {
    const problems = [];
    for (const groupName of ['steps', 'climate', 'temperature', 'drywet']) {
      if (!anchor[groupName]) continue;
      const actual = findRegion(groups[groupName], anchor.lon, anchor.lat);
      if (actual !== anchor[groupName]) {
        problems.push(groupName + ': 期望 ' + anchor[groupName] + '，实际 ' + actual);
      }
    }
    if (problems.length) failed += 1;
    details.push({
      name: anchor.name,
      lon: anchor.lon,
      lat: anchor.lat,
      ok: problems.length === 0,
      problems
    });
    console.log('      ' + (problems.length ? 'FAIL ' : 'PASS ') + anchor.name.padEnd(4) + '  ' +
      (problems.length ? problems.join('；') : 'OK'));
  }
  console.log('      共检查 ' + ANCHOR_CHECKS.length + ' 个城市，异常 ' + failed + ' 个');
  return { checked: ANCHOR_CHECKS.length, failed, details };
}

function validateLandforms(groups) {
  console.log('[5/6] 地形区关键点坐标检查 ...');
  let failed = 0;
  const details = [];
  const landforms = groups.landforms || {};
  for (const check of LANDFORM_CHECKS) {
    const actual = Object.keys(landforms).filter((id) => pointInGeometry(landforms[id], check.lon, check.lat));
    const problems = [];
    for (const id of check.include || []) {
      if (!actual.includes(id)) problems.push('期望包含 ' + id + '，实际未包含');
    }
    for (const id of check.exclude || []) {
      if (actual.includes(id)) problems.push('不应包含 ' + id + '，实际命中');
    }
    if (problems.length) failed += 1;
    details.push({
      name: check.name,
      lon: check.lon,
      lat: check.lat,
      ok: problems.length === 0,
      actual,
      problems
    });
    console.log('      ' + (problems.length ? 'FAIL ' : 'PASS ') + check.name.padEnd(4) + '  ' +
      (problems.length ? problems.join('；') : 'OK'));
  }
  console.log('      共检查 ' + LANDFORM_CHECKS.length + ' 个地形区关键点，异常 ' + failed + ' 个');
  return { checked: LANDFORM_CHECKS.length, failed, details };
}

/* ---------- 中国轮廓 ---------- */
const rawGeoJson = JSON.parse(fs.readFileSync(SOURCE_GEOJSON, 'utf8'));
const provinceGeometries = rawGeoJson.features
  .filter((feature) => feature.properties?.name && feature.properties?.adcode !== '100000_JD')
  .map((feature) => toClippingGeometry(feature.geometry))
  .filter(Boolean);

console.log('[1/6] 合并省级边界为中国轮廓 ...');
const china = unionMany(provinceGeometries);
console.log('      中国轮廓多边形数：' + china.length);

function clipZone(ring) {
  return pc.intersection(polygonFromRing(ring), china);
}

function subtractMany(geometry, cutters) {
  const valid = cutters.filter((g) => g && g.length);
  if (!geometry || !geometry.length || !valid.length) return geometry || [];
  let result = geometry;
  for (const cutter of valid) result = pc.difference(result, cutter);
  return result;
}

/* ---------- 三级阶梯边界（共享，确保线与面完全一致） ---------- */
// 第一、二级阶梯：昆仑山—祁连山—横断山一线
const stepBoundary12 = [
  [75.0,36.5],[78.0,36.5],[82.0,36.6],[85.0,36.6],[88.0,37.0],[90.0,37.8],
  [92.0,38.8],[94.0,39.2],[96.0,39.0],[98.0,38.3],[100.0,37.6],[102.0,36.9],
  [103.5,35.5],[103.3,34.0],[102.5,32.2],[101.5,30.2],[100.4,28.4],
  [99.3,27.1],[98.3,26.1]
];
// 第二、三级阶梯：大兴安岭—太行山—巫山—雪峰山一线
const stepBoundary23 = [
  [123.0,53.3],[122.6,51.7],[121.8,50.2],[120.9,48.6],[120.0,47.0],[119.2,45.5],
  [118.4,44.1],[117.6,42.8],[116.9,41.8],[115.9,40.9],[114.8,39.9],[114.1,38.7],
  [113.7,37.4],[113.4,36.1],[112.8,34.9],[111.8,33.6],[110.9,32.3],[110.5,31.1],
  [110.4,29.9],[110.6,28.7],[110.7,27.4],[110.3,26.2],[109.8,25.0],
  [109.2,23.7],[108.7,22.3]
];

const stepOneShape = [
  ...stepBoundary12,
  [98.0,18.0],[70.0,18.0],[70.0,40.0]
];
// 第三级阶梯从大兴安岭以东展开，向东南一直包括台湾与海南岛。
const stepThreeShape = [
  ...stepBoundary23,
  [108.0,21.0],[107.6,19.0],[107.6,18.0],
  [115.0,15.0],[140.0,15.0],[140.0,56.0],[124.5,55.0]
];

/* ---------- 气候类型示意多边形 ---------- */
const climateShapes = {
  highMountain: stepOneShape,
  tropical: [
    [97.0,24.4],[98.5,24.2],[100.0,23.9],[101.5,23.6],[103.0,23.3],[104.5,23.0],
    [106.0,22.8],[107.5,22.5],[109.0,22.2],[110.4,21.9],[111.8,21.9],[113.2,22.1],
    [114.5,22.4],[115.8,22.8],[117.0,23.1],[118.2,23.4],[119.4,23.5],[120.5,23.2],
    [121.3,22.8],[122.0,22.2],[125.0,18.0],[115.0,16.5],[108.0,17.5],[107.0,19.0],
    [105.0,20.0],[102.0,21.5],[99.0,22.5],[97.0,23.5]
  ],
  subtropical: [
    [103.5,34.1],[106.0,33.7],[109.0,33.4],[112.0,33.1],[115.0,33.2],[118.0,33.7],
    [120.5,33.3],[122.0,32.8],[140.0,33.0],[140.0,15.0],[90.0,15.0],[90.0,34.1]
  ],
  temperateMonsoon: [
    [124.0,54.0],[127.0,54.0],[132.0,51.0],[134.0,47.0],[134.0,32.0],
    [122.0,32.9],[120.5,33.0],[118.0,33.4],[115.0,32.9],[112.0,32.9],
    [109.0,33.2],[106.0,33.4],[103.5,33.8],
    [105.5,36.6],[107.0,38.2],[109.0,39.6],[111.0,40.8],[113.0,41.8],
    [115.0,42.8],[117.0,44.5],[119.0,47.0],[121.0,49.8],[122.5,52.0]
  ]
};

/* ---------- 干湿地区示意多边形 ---------- */
const dryWetShapes = {
  // 湿润区：秦岭—淮河以南、四川盆地、云南南部至东南沿海
  humid: [
    [97.0,21.5],[98.0,22.5],[99.0,23.5],[100.0,24.5],[100.5,25.5],
    [101.0,26.5],[102.0,28.0],[103.0,30.0],[104.0,31.5],[104.5,32.5],
    [105.5,33.3],[107.0,33.8],[109.0,34.0],[111.0,34.0],[113.0,34.0],
    [115.0,34.2],[117.0,34.4],[119.0,34.0],[120.5,33.0],[121.5,31.5],
    [122.0,29.0],[121.0,27.0],[120.0,25.0],[118.0,23.5],[116.0,22.8],
    [114.0,22.2],[112.0,21.5],[110.5,21.0],[109.0,20.5],[108.0,20.0],
    [106.5,20.5],[105.0,21.0],[103.5,21.0],[102.0,21.2],[100.5,21.3],
    [99.0,21.3],[98.0,21.2]
  ],
  // 海南岛与台湾岛的湿润区单独成环，再与中国轮廓求交
  humidHainan: [
    [108.3,18.0],[110.8,17.8],[111.2,19.5],[110.8,20.2],[109.5,20.2],[108.5,19.5]
  ],
  humidTaiwan: [
    [120.0,21.7],[122.0,21.7],[122.0,25.5],[120.0,25.5]
  ],
  // 东北东部的湿润区：大兴安岭以东的东部山地、三江平原和长白山东侧
  humidNE: [
    [120.0,53.5],[123.0,53.8],[126.5,53.0],[130.5,52.0],[133.5,50.0],
    [134.5,47.0],[135.0,45.5],[133.5,44.0],[131.0,42.5],[129.0,42.0],
    [127.5,43.0],[127.0,45.0],[126.5,47.0],[121.5,48.5],[119.5,50.5]
  ],
  // 半湿润区：华北、东北中部、黄土高原东部至青藏高原东缘
  semiHumid: [
    [111,33.5],[114,33.8],[116,34.2],[118,34.5],[120,35],[121.5,36.5],[122.5,38.5],
    [123.5,40.5],[124.5,42.5],[127.0,45.0],[126.5,48.0],[124.5,50],[119.0,50.5],
    [116.0,49.5],[114.5,47.5],[117,45],[116.0,43.0],[114.5,41.8],[113.0,40.5],
    [108.5,39],[106.5,37.5],
    [105.5,36],[106.5,34.5],[108.5,34],[110,33.8]
  ],
  // 青藏高原东缘的半湿润带（兰州、青海东部一带）
  semiHumidWest: [
    [98.5,31.0],[100.0,32.5],[102.0,34.0],[104.5,35.5],[105.0,36.5],
    [103.5,38.0],[101.5,37.5],[99.5,36.0],[98.0,34.0],[98.0,32.5]
  ],
  // 半干旱区：内蒙古高原、黄土高原北部、准噶尔盆地
  semiAridNorth: [
    [96,41],[99,43],[103,45],[108,46],[112,47],[116,46],[118,44],[118,42],
    [116,40],[114,38],[112,36.5],[110,35],[108,34.5],[106,35],[104,36],[102,37],
    [100,38.5],[98,39.5]
  ],
  semiAridJunggar: [
    [80.0,44.5],[81.5,46.3],[83.5,47.3],[86.5,47.8],[89.0,47.4],
    [91.0,46.5],[91.5,45.2],[90.0,44.0],[88.0,43.4],[85.5,43.6],[83.0,44.0]
  ],
  // 青藏高原主体：拉萨、日喀则、阿里南部为半干旱区；柴达木和藏北更干旱
  semiAridTibet: [
    [79.0,31.0],[80.0,34.0],[82.0,35.5],[85.0,36.0],[88.0,36.2],
    [91.0,36.0],[94.0,35.5],[97.0,34.8],[100.0,33.5],[101.5,31.5],
    [100.0,29.5],[98.0,28.0],[95.0,28.0],[92.0,28.5],[89.0,29.0],
    [86.0,29.0],[83.0,29.5],[80.5,30.0]
  ]
};

/* ---------- 三级阶梯图形已在气候类型之前定义 ----------
   第一级 = stepOneShape；第三级 = stepThreeShape；第二级 = 中国范围减去一、三级。
   这样保证阶梯分界线与三块区域使用同一组坐标。 */

/* ---------- 温度带示意多边形 ---------- */
const temperatureShapes = {
  // 暖温带：塔里木盆地、河西走廊、黄土高原、华北平原至辽东半岛南部
  warmTemperate: [
    [75.0,41.4],[80.0,42.4],[85.0,42.6],[90.0,42.4],[94.0,41.6],[97.0,40.5],
    [100.0,39.8],[103.0,39.0],[106.0,38.8],[109.0,39.5],[112.0,40.2],
    [115.0,40.5],[117.5,40.5],[120.0,40.2],[122.0,40.0],[124.0,38.0],
    [124.0,33.0],[122.0,33.0],[120.5,33.3],[118.0,33.7],[115.0,33.2],
    [112.0,33.1],[109.0,33.4],[106.0,33.7],[103.5,34.1],
    [100.0,34.2],[96.0,34.5],[92.0,35.0],[88.0,35.5],[84.0,36.0],
    [80.0,36.5],[77.0,37.5],[75.0,39.0]
  ],
  // 寒温带：大兴安岭最北端
  coldTemperate: [
    [121.5,50.3],[123.5,50.0],[125.4,50.8],[126.2,52.2],[125.5,53.5],
    [123.5,53.6],[121.5,52.5],[120.8,51.3]
  ]
};

/* ---------- 四大高原 / 四大盆地 / 三大平原 ---------- */
// 自然地理教学示意范围，不是行政边界；青藏高原直接复用第一阶梯轮廓，
// 避免同一个高原出现两套不一致的边界。
const landformShapes = {
  plateau_qinghaiTibet: stepOneShape,

  // 内蒙古高原：北抵国界，南沿阴山—大青山，东至大兴安岭，西接阿拉善。
  plateau_innerMongolia: [
    [96.0,40.6],[98.0,42.0],[101.0,43.5],[104.0,45.0],[108.0,46.0],
    [112.0,47.0],[116.0,47.5],[119.0,48.5],[120.0,50.5],[121.0,53.5],
    [122.0,52.0],[120.8,50.0],[120.2,47.5],[119.2,45.5],[118.3,43.5],
    [117.0,41.8],[114.0,40.9],[111.0,40.8],[108.0,40.8],[105.0,40.8],
    [102.0,41.0],[99.0,40.8]
  ],

  // 黄土高原：太行山以西、乌鞘岭以东、长城以南、秦岭以北。
  plateau_loess: [
    [102.0,36.0],[102.3,37.8],[103.5,39.5],[105.0,40.5],[107.5,40.6],
    [110.0,40.5],[112.5,40.2],[114.0,39.0],[114.0,37.2],[113.4,35.6],
    [112.0,34.4],[110.0,34.0],[108.0,34.3],[106.5,35.0],[104.8,35.2],
    [103.2,35.4]
  ],

  // 云贵高原：云南东部、贵州大部及桂西北，南界约为热带北缘。
  plateau_yunnanGuizhou: [
    [99.6,25.5],[100.4,26.8],[101.5,27.6],[103.0,28.2],[105.0,28.5],
    [107.0,28.4],[108.8,27.8],[110.0,27.0],[110.3,25.8],[109.5,24.5],
    [108.2,23.5],[106.5,22.9],[104.5,22.4],[102.8,22.8],[101.2,23.6],
    [100.0,24.5]
  ],

  // 塔里木盆地：天山南麓、昆仑山—阿尔金山北麓之间，东至罗布泊洼地。
  basin_tarim: [
    [74.5,39.2],[75.5,40.6],[77.5,41.5],[80.0,42.0],[83.0,42.2],
    [85.5,41.8],[88.0,41.2],[90.0,40.3],[90.5,39.0],[89.5,37.8],
    [87.0,36.8],[84.0,36.4],[81.0,36.6],[78.0,37.2],[76.0,38.1],
    [74.8,38.8]
  ],

  // 准噶尔盆地：阿尔泰山与天山之间，略呈三角形，西部有山口。
  basin_junggar: [
    [80.5,45.0],[81.8,46.5],[83.8,47.4],[86.5,47.8],[89.0,47.4],
    [91.0,46.5],[91.5,45.2],[90.0,44.2],[88.2,43.6],[85.5,43.7],
    [83.0,44.0]
  ],

  // 柴达木盆地：阿尔金山—祁连山与昆仑山之间的高原内陆盆地。
  basin_qaidam: [
    [90.0,36.4],[90.8,37.8],[92.5,38.9],[95.0,39.3],[97.5,39.2],
    [99.0,38.3],[99.8,37.0],[98.8,35.8],[96.5,35.3],[94.0,35.2],
    [91.8,35.6]
  ],

  // 四川盆地：龙泉山—龙门山以东、大巴山以南、巫山以西、云贵高原以北。
  basin_sichuan: [
    [102.7,29.2],[103.3,31.0],[104.8,32.4],[106.8,32.6],[108.4,31.8],
    [109.2,30.2],[108.5,28.8],[106.7,28.2],[104.5,28.2],[103.2,28.7]
  ],

  // 东北平原：大兴安岭以东、小兴安岭以南、长白山以西，南至辽河入海口。
  plain_northeast: [
    [121.0,50.5],[123.0,50.8],[125.0,50.0],[127.0,49.0],[129.0,48.5],
    [132.5,48.6],[134.5,47.6],[133.5,46.0],[131.5,45.2],[129.5,46.0],
    [128.5,45.0],[127.0,43.4],[126.2,42.2],[125.2,41.0],
    [123.8,40.8],[122.5,41.2],[121.3,42.5],[120.8,44.5],[120.8,47.0]
  ],

  // 华北平原：燕山以南、太行山以东、淮河以北，黄河—海河—淮河冲积平原。
  plain_northChina: [
    [113.4,35.0],[113.7,37.0],[114.5,39.0],[115.3,40.2],[117.0,40.6],
    [119.5,40.3],[121.0,39.2],[121.8,37.8],[120.8,36.8],[120.0,35.8],
    [120.8,34.6],[119.0,33.0],[117.0,32.3],[115.0,32.6],[113.5,33.5]
  ],

  // 长江中下游平原：江汉平原、洞庭湖平原、鄱阳湖平原、苏皖沿江平原和长江三角洲。
  plain_yangtze: [
    [110.8,30.2],[111.5,31.5],[113.0,32.2],[114.8,32.4],[116.5,32.6],
    [118.5,32.3],[120.2,31.8],[121.9,31.4],[121.7,30.2],[120.0,28.8],
    [118.0,28.5],[116.0,28.2],[114.5,28.8],[112.8,29.3],[111.5,29.6]
  ]
};

/* ---------- 组装专题区 ---------- */
console.log('[2/6] 生成三级阶梯 ...');
const stepOne = clipZone(stepOneShape);
const stepThree = clipZone(stepThreeShape);
const stepTwo = pc.difference(china, pc.union(stepOne, stepThree));

console.log('[3/6] 生成气候类型区 ...');
// 高原山地气候使用第一阶梯轮廓；热带、亚热带、温带季风依次裁剪；
// 温带大陆性气候取剩余区，保证五类气候合起来覆盖全部陆地。
const highMountain = stepOne;
const tropical = subtractMany(clipZone(climateShapes.tropical), [highMountain]);
const subtropical = subtractMany(clipZone(climateShapes.subtropical), [highMountain, tropical]);
const temperateMonsoon = subtractMany(clipZone(climateShapes.temperateMonsoon), [highMountain, tropical, subtropical]);
const temperateContinental = pc.difference(china, unionMany([highMountain, tropical, subtropical, temperateMonsoon]));
const climateRaw = { highMountain, tropical, subtropical, temperateMonsoon, temperateContinental };

console.log('[4/6] 生成干湿地区 ...');
const seenDryWet = [];
const dryWetRaw = {};
for (const id of ['humid','humidHainan','humidTaiwan','humidNE','semiHumid','semiHumidWest','semiAridNorth','semiAridJunggar','semiAridTibet']) {
  let zone = clipZone(dryWetShapes[id]);
  zone = subtractMany(zone, seenDryWet);
  dryWetRaw[id] = zone;
  seenDryWet.push(zone);
}
dryWetRaw.humid = unionMany([
  dryWetRaw.humid, dryWetRaw.humidNE, dryWetRaw.humidHainan, dryWetRaw.humidTaiwan
]);
delete dryWetRaw.humidNE;
delete dryWetRaw.humidHainan;
delete dryWetRaw.humidTaiwan;
dryWetRaw.semiHumid = unionMany([dryWetRaw.semiHumid, dryWetRaw.semiHumidWest]);
delete dryWetRaw.semiHumidWest;
dryWetRaw.semiAridNorth = unionMany([dryWetRaw.semiAridNorth, dryWetRaw.semiAridJunggar]);
delete dryWetRaw.semiAridJunggar;
dryWetRaw.arid = pc.difference(china, unionMany([
  dryWetRaw.humid, dryWetRaw.semiHumid, dryWetRaw.semiAridNorth, dryWetRaw.semiAridTibet
]));

console.log('[5/6] 生成温度带与四大高原 / 四大盆地 / 三大平原 ...');
const temperatureRaw = {};
const seenTemperature = [];
for (const id of ['plateau','tropical','subtropical','warmTemperate','coldTemperate']) {
  let shape;
  if (id === 'plateau') shape = stepOneShape;
  else if (id === 'tropical' || id === 'subtropical') shape = climateShapes[id];
  else shape = temperatureShapes[id];
  let zone = clipZone(shape);
  zone = subtractMany(zone, seenTemperature);
  temperatureRaw[id] = zone;
  seenTemperature.push(zone);
}
temperatureRaw.midTemperate = pc.difference(china, unionMany(seenTemperature));

const landformRaw = {};
for (const [id, shape] of Object.entries(landformShapes)) landformRaw[id] = clipZone(shape);

const simplifySets = {};
function addSet(groupName, rawMap) {
  simplifySets[groupName] = {};
  for (const [id, geometry] of Object.entries(rawMap)) {
    const cleaned = cleanGeometry(geometry);
    simplifySets[groupName][id] = cleaned;
    console.log('      ' + groupName + '/' + id.padEnd(26) +
      ' 多边形 ' + String(cleaned.length).padStart(3) +
      ' · 坐标 ' + String(countCoordinates(cleaned)).padStart(4) +
      ' · 面积指数 ' + outerArea(cleaned).toFixed(2));
  }
}
addSet('steps', { step1: stepOne, step2: stepTwo, step3: stepThree });
addSet('climate', climateRaw);
addSet('drywet', dryWetRaw);
addSet('temperature', temperatureRaw);
addSet('landforms', landformRaw);

const anchorValidation = validateAnchors(simplifySets);
const landformValidation = validateLandforms(simplifySets);
const validation = Object.assign({}, anchorValidation, { landform: landformValidation });
if (anchorValidation.failed > 0 || landformValidation.failed > 0) {
  console.error('校验未通过，已停止输出；请先修正多边形或关键点。');
  process.exit(1);
}

const payload = {
  meta: {
    title: '中国地理互动地图 · 专题区划示意数据',
    generatedAt: new Date().toISOString(),
    source: '省界底稿：阿里云 DataV.GeoAtlas（100000_full）',
    note: '所有专题边界均为教学示意，不是权威区划，仅供课堂展示与交互学习。',
    simplifyTolerance: SIMPLIFY_TOLERANCE,
    validation
  },
  groups: simplifySets
};

const header = '/* ============================================================================\n' +
  ' * 中国地理互动地图 · 专题几何数据（自动生成，请勿手工编辑）\n' +
  ' * ----------------------------------------------------------------------------\n' +
  ' * 由 scripts/build_thematic_data.mjs 生成。\n' +
  ' * 用途：为 assets/app.js 提供气候、干湿、三级阶梯、温度带、地形区的裁剪后多边形。\n' +
  ' * 注意：这是教学示意边界，不是官方自然资源区划，也不用于权属判断。\n' +
  ' * 源省界：DataV.GeoAtlas；底图与行政注记：天地图。\n' +
  ' * ========================================================================== */\n';
fs.writeFileSync(OUTPUT_JS, header + 'window.CHINA_ATLAS_GEO = ' + JSON.stringify(payload) + ';\n', 'utf8');
fs.writeFileSync(DEBUG_JSON, JSON.stringify({ ...payload, country: cleanGeometry(china, 0.008) }), 'utf8');

const stat = fs.statSync(OUTPUT_JS);
console.log('[6/6] 输出完成');
console.log('      文件：' + OUTPUT_JS);
console.log('      大小：' + (stat.size / 1024).toFixed(1) + ' KB');
console.log('      坐标总数：' + Object.values(simplifySets).reduce((sum, group) =>
  sum + Object.values(group).reduce((s, g) => s + countCoordinates(g), 0), 0));
