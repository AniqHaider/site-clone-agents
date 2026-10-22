#!/usr/bin/env node
/**
 * harvest-extract.mjs — Deterministic bulk extraction for the nextjs-clone Phase 1 harvest.
 *
 * Replaces the heavy, token-taxed MCP `browser_evaluate` round-trips with a single
 * Playwright run that writes harvest.json + assets STRAIGHT TO DISK (zero model context).
 *
 * What it extracts (the deterministic, non-interactive part of harvest):
 *   - Aggregated design tokens (colors, fonts, spacings, radii, shadows)
 *   - Raw CSS :hover/:focus/:active rules from stylesheets
 *   - Per-element computed styles at 4 breakpoints   <-- pixel-fidelity payload
 *   - Network capture: fonts (downloaded), image srcsets, XHR/fetch JSON
 *   - Inline SVGs (incl. hidden), background images, <img> elements
 *   - Section-clipped screenshots at 4 breakpoints
 *   - Sticky/scroll/transition behaviors
 *   - Section HTML snippet
 *   - @font-face routing plan (family → weights → local file / google)   <-- v2
 *   - CSS custom-property (var) references + resolved values + valueKind  <-- v2
 *   - Editor-flat content model (footer/nav link groups, social, contact) <-- v2
 *   - JS-animation fingerprint (libs, @keyframes, AOS attrs, live anims)  <-- v2
 *   - Reveal candidates: triggers + statically-hidden dropdown/modal HTML <-- v2
 *
 * What it does NOT do (stays in the MCP-driven agent, which merges into harvest.json):
 *   - Hover-state captures, click/toggle interactions, scroll-reveal triggering
 *   - JS-mounted (React portal) reveals that only exist AFTER a click — the static
 *     revealCandidates extractor only sees CSS-hidden panels already in the DOM
 *
 * Usage:
 *   node harvest-extract.mjs --session <sessionDir> --section <SectionName> [--download-images] [--headed]
 *
 * Exit codes: 0 ok, 1 fatal (bad args / section not found / browser launch fail).
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const SESSION = arg('session');
const SECTION = arg('section');
const DOWNLOAD_IMAGES = arg('download-images', false) === true;
const HEADED = arg('headed', false) === true;

if (!SESSION || !SECTION) {
  console.error('ERROR: --session <dir> and --section <name> are required.');
  process.exit(1);
}

const BREAKPOINTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'tablet-1024', width: 1024, height: 800 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-360', width: 360, height: 800 },
];

const sectionDir = join(SESSION, SECTION);
const dirs = {
  root: sectionDir,
  svgs: join(sectionDir, 'svgs'),
  screenshots: join(sectionDir, 'screenshots'),
  fonts: join(sectionDir, 'assets', 'fonts'),
  images: join(sectionDir, 'assets', 'images'),
  network: join(sectionDir, 'network'),
  api: join(sectionDir, 'network', 'api'),
};

const log = (...a) => console.log(`[harvest:${SECTION}]`, ...a);
const warn = (...a) => console.warn(`[harvest:${SECTION}] WARN`, ...a);

async function main() {
  // ---------- read config ----------
  const configPath = join(SESSION, 'config.json');
  const sectionsPath = join(SESSION, 'sections.json');
  if (!existsSync(configPath)) { console.error(`ERROR: ${configPath} not found`); process.exit(1); }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const url = config.url;
  if (!url) { console.error('ERROR: config.json has no "url" (is this a figma session?)'); process.exit(1); }

  let selector = null, sectionMeta = null;
  if (existsSync(sectionsPath)) {
    const sections = JSON.parse(await readFile(sectionsPath, 'utf8'));
    const list = Array.isArray(sections) ? sections : sections.sections || [];
    sectionMeta = list.find(s => (s.name || s.section) === SECTION) || null;
    selector = sectionMeta?.selector || null;
  }
  if (!selector) {
    warn(`no selector for "${SECTION}" in sections.json — falling back to <body>`);
    selector = 'body';
  }

  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  // ---------- launch ----------
  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED });
  } catch (e) {
    console.error('ERROR launching chromium. If browsers are missing, run:');
    console.error('  cd scripts && npx playwright install chromium');
    console.error(String(e));
    process.exit(1);
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ---------- network capture (attach before navigation) ----------
  const netManifest = []; // { url, resourceType, status, contentType, savedTo? }
  const fontDownloads = [];
  const apiResponses = [];
  const seenUrls = new Set();

  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const rurl = resp.url();
      const rtype = req.resourceType();
      const ct = (resp.headers()['content-type'] || '').split(';')[0];
      const status = resp.status();
      if (seenUrls.has(rurl)) return;
      seenUrls.add(rurl);

      const entry = { url: rurl, resourceType: rtype, status, contentType: ct };

      // Fonts — always download (small, critical for fidelity)
      if (rtype === 'font' || /font\/|woff2?|ttf|otf|eot/.test(ct) || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(rurl)) {
        try {
          const buf = await resp.body();
          let fname = basename(new URL(rurl).pathname) || `font-${fontDownloads.length}`;
          if (!extname(fname)) fname += (ct.includes('woff2') ? '.woff2' : ct.includes('woff') ? '.woff' : '.ttf');
          await writeFile(join(dirs.fonts, fname), buf);
          entry.savedTo = `assets/fonts/${fname}`;
          fontDownloads.push({ url: rurl, file: entry.savedTo, contentType: ct });
        } catch (e) { entry.error = 'font-body-failed'; }
      }

      // XHR/fetch JSON — the real API data behind dynamic sections
      else if ((rtype === 'xhr' || rtype === 'fetch') && /json/.test(ct)) {
        try {
          const text = await resp.text();
          if (text && text.length < 2_000_000) {
            const safe = (new URL(rurl).pathname.replace(/[^a-z0-9]/gi, '_').slice(-60) || 'resp') + `_${apiResponses.length}.json`;
            await writeFile(join(dirs.api, safe), text);
            entry.savedTo = `network/api/${safe}`;
            apiResponses.push({ url: rurl, file: entry.savedTo, status });
          }
        } catch (e) { entry.error = 'json-body-failed'; }
      }

      netManifest.push(entry);
    } catch (e) { /* never let a response handler crash the run */ }
  });

  // ---------- navigate + scroll to trigger lazy loading ----------
  log(`navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }));
  await autoScroll(page);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  const sectionExists = await page.$(selector);
  if (!sectionExists) {
    warn(`selector "${selector}" not found on page — screenshots/computed-styles will be empty`);
  }

  // ---------- static extractions (single eval each, results go to disk) ----------
  const designTokens = await safeEval(page, EXTRACTORS.designTokens, selector, {});
  const cssRulesRaw = await safeEval(page, EXTRACTORS.cssPseudoRules, selector, { rules: [] });
  const svgData = await safeEval(page, EXTRACTORS.svgs, selector, { svgs: [] });
  const bgImages = await safeEval(page, EXTRACTORS.bgImages, selector, { images: [] });
  const imgs = await safeEval(page, EXTRACTORS.images, selector, { images: [] });
  const scrollBehaviors = await safeEval(page, EXTRACTORS.scrollBehaviors, selector, []);
  const transitions = await safeEval(page, EXTRACTORS.transitions, selector, []);
  const snippet = await safeEval(page, EXTRACTORS.snippet, selector, null);
  // NEW (v2) extractions
  const fontFaceData = await safeEval(page, EXTRACTORS.fontFaces, selector, { usedFamilies: [], fontFaces: [] });
  const cssVarData = await safeEval(page, EXTRACTORS.cssVariables, selector, { variables: [] });
  const contentModel = await safeEval(page, EXTRACTORS.contentModel, selector, { linkGroups: [], socialLinks: [], contactItems: [], allLinks: [] });
  const jsAnimations = await safeEval(page, EXTRACTORS.jsAnimations, selector, { libraries: [], keyframes: [], aos: [], liveAnimations: [], carousels: [] });
  const revealData = await safeEval(page, EXTRACTORS.revealCandidates, selector, { triggers: [], hiddenPanels: [] });

  // Save SVG files (dedupe filenames so no SVG is silently overwritten)
  const svgItems = [];
  const usedSvgNames = new Set();
  for (const s of (svgData.svgs || [])) {
    let base = s.name || `svg-${s.index}`;
    let name = base;
    let k = 1;
    while (usedSvgNames.has(name)) name = `${base}-${k++}`;
    usedSvgNames.add(name);
    const file = `svgs/${name}.svg`;
    try { await writeFile(join(sectionDir, file), s.outerHTML); } catch {}
    svgItems.push({ name, viewBox: s.viewBox, visible: s.visible, ariaLabel: s.ariaLabel, filePath: file, boundingRect: s.boundingRect });
  }

  // Save snippet
  if (snippet) await writeFile(join(sectionDir, 'snippet.html'), snippet).catch(() => {});

  // Optionally download <img> assets
  if (DOWNLOAD_IMAGES) {
    let n = 0;
    for (const im of (imgs.images || [])) {
      if (n >= 60) { warn('image download capped at 60'); break; }
      try {
        const r = await context.request.get(im.src, { timeout: 15000 });
        if (r.ok()) {
          let fname = basename(new URL(im.src).pathname) || `img-${n}`;
          if (!extname(fname)) fname += '.img';
          await writeFile(join(dirs.images, fname), await r.body());
          im.localFile = `assets/images/${fname}`;
          n++;
        }
      } catch {}
    }
    log(`downloaded ${n} images`);
  }

  // ---------- per-breakpoint: computed styles + section screenshot ----------
  const computedStyles = {};   // breakpoint -> [ {path, tag, role, styles} ]
  const screenshotPaths = {};
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await page.waitForTimeout(500);
    // computed styles for structurally-significant elements
    computedStyles[bp.name] = await safeEval(page, EXTRACTORS.computedStyles, selector, []);
    // section-clipped screenshot
    try {
      const el = await page.$(selector);
      const shotFile = `screenshots/${bp.name}.png`;
      if (el && (await el.boundingBox())) {
        await el.screenshot({ path: join(sectionDir, shotFile) });
      } else {
        await page.screenshot({ path: join(sectionDir, shotFile), fullPage: false });
      }
      screenshotPaths[bp.name] = shotFile;
    } catch (e) { warn(`screenshot failed at ${bp.name}: ${e.message}`); }
  }

  await browser.close();

  // ---------- split css rules by pseudo-class ----------
  const all = cssRulesRaw.rules || [];
  const cssRules = {
    totalRules: all.length,
    hoverRules: all.filter(r => /:hover/.test(r.selector)),
    focusRules: all.filter(r => /:focus/.test(r.selector)),
    activeRules: all.filter(r => /:active/.test(r.selector)),
  };

  // ---------- write network manifest ----------
  await writeFile(join(dirs.network, 'requests.json'), JSON.stringify({
    totalRequests: netManifest.length,
    fonts: fontDownloads,
    apiResponses,
    byType: countBy(netManifest, 'resourceType'),
    requests: netManifest,
  }, null, 2));

  // ---------- font routing plan (merge @font-face rules with downloaded files) ----------
  const fontFaceList = (fontFaceData.fontFaces || []).filter(f => !f._corsBlocked);
  const corsBlockedSheets = (fontFaceData.fontFaces || []).filter(f => f._corsBlocked).map(f => f.href);
  const fonts = {
    usedFamilies: fontFaceData.usedFamilies || [],
    plan: buildFontPlan(fontFaceList, fontDownloads),
    faces: fontFaceList,
    downloaded: fontDownloads,
    corsBlockedSheets,
  };

  // ---------- assemble harvest.json (static portion) ----------
  const harvest = {
    section: SECTION,
    selector,
    url,
    harvestedAt: new Date().toISOString(),
    extractor: 'harvest-extract.mjs',
    extractorVersion: 2,
    // interactions left null — the MCP-driven agent fills this and re-writes
    interactions: null,

    designTokens,
    cssRules,
    cssVariables: cssVarData.variables || [],   // NEW (v2)
    computedStyles,                       // per-element, per-breakpoint
    network: {
      fonts: fontDownloads,
      apiResponses,
      manifestPath: 'network/requests.json',
    },
    fonts,                                // NEW (v2): @font-face routing plan
    contentModel,                         // NEW (v2): editor-flat link groups
    jsAnimations,                         // NEW (v2): libs / keyframes / aos / live / carousels
    reveals: revealData,                  // NEW (v2): triggers + statically-hidden panels
    svgs: { totalSvgs: svgItems.length, items: svgItems },
    backgroundImages: bgImages.images || [],
    images: imgs.images || [],
    scrollBehaviors,
    transitionProperties: transitions,
    screenshotPaths,
    snippetPath: snippet ? 'snippet.html' : null,
  };

  await writeFile(join(sectionDir, 'harvest.json'), JSON.stringify(harvest, null, 2));

  // ---------- summary (this is all that hits the agent's context) ----------
  const summary = {
    section: SECTION,
    selector,
    sectionFound: !!sectionExists,
    tokens: {
      colors: (designTokens.colors || []).length,
      fonts: (designTokens.fontFamilies || []).length,
      spacings: (designTokens.spacings || []).length,
    },
    cssPseudoRules: { hover: cssRules.hoverRules.length, focus: cssRules.focusRules.length, active: cssRules.activeRules.length },
    cssVariables: (cssVarData.variables || []).length,
    svgs: svgItems.length,
    backgroundImages: (bgImages.images || []).length,
    images: (imgs.images || []).length,
    fontsDownloaded: fontDownloads.length,
    fontFaces: fontFaceList.length,
    fontPlan: fonts.plan.map(p => `${p.family}:${p.strategy}`),
    contentLinkGroups: (contentModel.linkGroups || []).length,
    socialLinks: (contentModel.socialLinks || []).length,
    jsAnimationLibs: jsAnimations.libraries || [],
    keyframes: (jsAnimations.keyframes || []).length,
    revealTriggers: (revealData.triggers || []).length,
    revealHiddenPanels: (revealData.hiddenPanels || []).length,
    apiJsonCaptured: apiResponses.length,
    computedStyleElements: computedStyles['desktop-1440']?.length || 0,
    screenshots: Object.keys(screenshotPaths),
    harvestJson: join(sectionDir, 'harvest.json'),
  };
  console.log('\n=== HARVEST SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

// ---------- helpers ----------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 500;
      const timer = setInterval(() => {
        const h = document.documentElement.scrollHeight;
        window.scrollTo(0, y);
        y += step;
        if (y >= h) { clearInterval(timer); resolve(); }
      }, 200);
    });
  }).catch(() => {});
}

async function safeEval(page, fnString, sel, fallback) {
  try {
    return await page.evaluate(({ fn, sel }) => {
      // eslint-disable-next-line no-new-func
      const f = new Function('return (' + fn + ')')();
      return f(sel);
    }, { fn: fnString, sel });
  } catch (e) {
    console.warn(`[safeEval] failed: ${e.message}`);
    return fallback;
  }
}

function countBy(arr, key) {
  return arr.reduce((acc, x) => { acc[x[key]] = (acc[x[key]] || 0) + 1; return acc; }, {});
}

// Merge @font-face rules with downloaded font files into a per-family next/font plan.
function buildFontPlan(faces, downloads) {
  const byFamily = {};
  for (const f of faces) {
    const fam = f.fontFamily || 'unknown';
    byFamily[fam] = byFamily[fam] || { family: fam, weights: new Set(), styles: new Set(), isGoogle: false, files: [] };
    byFamily[fam].weights.add(f.weight || '400');
    if (f.style) byFamily[fam].styles.add(f.style);
    if (f.isGoogle) byFamily[fam].isGoogle = true;
    for (const s of (f.src || [])) {
      const tail = (s.url || '').split('/').pop();
      const dl = downloads.find(d => d.url === s.url || (tail && d.url.endsWith(tail)) || (tail && (d.file || '').endsWith(tail)));
      if (dl) byFamily[fam].files.push(dl.file);
    }
  }
  return Object.values(byFamily).map(x => ({
    family: x.family,
    weights: [...x.weights],
    styles: [...x.styles],
    isGoogle: x.isGoogle,
    localFiles: [...new Set(x.files)],
    strategy: x.isGoogle ? 'next/font/google' : (x.files.length ? 'next/font/local' : 'css-fallback'),
  }));
}

// ---------- in-page extractor functions (stringified, run via safeEval) ----------
const EXTRACTORS = {
  designTokens: `(sectionSelector) => {
    const section = document.querySelector(sectionSelector);
    if (!section) return { error: 'Section not found' };
    const colors=new Set(),fontFamilies=new Set(),fontSizes=new Set(),fontWeights=new Set(),lineHeights=new Set(),letterSpacings=new Set(),borderRadii=new Set(),shadows=new Set(),spacings=new Set();
    section.querySelectorAll('*').forEach(el => {
      const s=getComputedStyle(el);
      [s.color,s.backgroundColor,s.borderColor,s.borderTopColor,s.borderBottomColor,s.outlineColor].forEach(c=>{if(c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')colors.add(c);});
      if(s.fontFamily)fontFamilies.add(s.fontFamily);
      if(s.fontSize)fontSizes.add(s.fontSize);
      if(s.fontWeight)fontWeights.add(s.fontWeight);
      if(s.lineHeight)lineHeights.add(s.lineHeight);
      if(s.letterSpacing&&s.letterSpacing!=='normal')letterSpacings.add(s.letterSpacing);
      if(s.borderRadius&&s.borderRadius!=='0px')borderRadii.add(s.borderRadius);
      if(s.boxShadow&&s.boxShadow!=='none')shadows.add(s.boxShadow);
      [s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft,s.marginTop,s.marginRight,s.marginBottom,s.marginLeft,s.gap,s.rowGap,s.columnGap].forEach(v=>{if(v&&v!=='0px'&&v!=='auto'&&v!=='normal')spacings.add(v);});
    });
    return {colors:[...colors],fontFamilies:[...fontFamilies],fontSizes:[...fontSizes].sort((a,b)=>parseFloat(a)-parseFloat(b)),fontWeights:[...fontWeights],lineHeights:[...lineHeights],letterSpacings:[...letterSpacings],borderRadii:[...borderRadii],shadows:[...shadows],spacings:[...spacings].sort((a,b)=>parseFloat(a)-parseFloat(b))};
  }`,

  cssPseudoRules: `(sectionSelector) => {
    const section=document.querySelector(sectionSelector);
    if(!section)return{rules:[]};
    const sectionClasses=new Set(),sectionIds=new Set(),sectionTags=new Set();
    section.querySelectorAll('*').forEach(el=>{el.classList.forEach(c=>sectionClasses.add(c));if(el.id)sectionIds.add(el.id);sectionTags.add(el.tagName.toLowerCase());});
    if(section.id)sectionIds.add(section.id);section.classList.forEach(c=>sectionClasses.add(c));
    const pseudoRules=[];
    for(const sheet of document.styleSheets){
      try{
        const walk=(rules,mq)=>{for(const rule of rules){
          if(rule.cssRules){walk(rule.cssRules,rule.conditionText||rule.media?.mediaText);continue;}
          const selector=rule.selectorText||'';
          if(!/:hover|:focus|:active|:focus-visible|:focus-within/.test(selector))continue;
          let relevant=false;
          for(const cls of sectionClasses){if(selector.includes('.'+cls)){relevant=true;break;}}
          if(!relevant)for(const id of sectionIds){if(selector.includes('#'+id)){relevant=true;break;}}
          if(!relevant)for(const tag of sectionTags){if(new RegExp('\\\\b'+tag+':').test(selector)){relevant=true;break;}}
          if(relevant){const properties={};for(let i=0;i<rule.style.length;i++){const p=rule.style[i];properties[p]=rule.style.getPropertyValue(p);}pseudoRules.push({selector,cssText:rule.cssText,properties,mediaQuery:mq||null,source:sheet.href||'inline'});}
        }};
        walk(sheet.cssRules||sheet.rules,null);
      }catch(e){}
    }
    return{totalRules:pseudoRules.length,rules:pseudoRules};
  }`,

  svgs: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{svgs:[]};
    const svgs=[];
    section.querySelectorAll('svg').forEach((svg,i)=>{
      const rect=svg.getBoundingClientRect();const parent=svg.parentElement;
      const ariaLabel=svg.getAttribute('aria-label')||parent?.getAttribute('aria-label')||parent?.getAttribute('title')||'';
      const parentText=parent?.textContent?.trim().substring(0,30)||'';
      const name=(ariaLabel||parentText||('svg-'+i)).replace(/[^a-zA-Z0-9-]/g,'-').toLowerCase().substring(0,40);
      svgs.push({index:i,name,viewBox:svg.getAttribute('viewBox'),outerHTML:svg.outerHTML,visible:rect.width>0&&rect.height>0,ariaLabel,boundingRect:{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}});
    });
    return{totalSvgs:svgs.length,svgs};
  }`,

  bgImages: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{images:[]};
    const out=[];
    const grab=(el,s,label)=>{if(s.backgroundImage&&s.backgroundImage!=='none'){const urls=s.backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/g);if(urls)urls.forEach(u=>{const url=u.replace(/url\\(["']?|["']?\\)/g,'');out.push({element:label,url,backgroundSize:s.backgroundSize,backgroundPosition:s.backgroundPosition,backgroundRepeat:s.backgroundRepeat});});}};
    section.querySelectorAll('*').forEach(el=>{
      const tag=el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className&&el.className.toString?'.'+el.className.toString().split(' ')[0]:'');
      grab(el,getComputedStyle(el),tag);
      ['::before','::after'].forEach(p=>grab(el,getComputedStyle(el,p),tag+p));
    });
    return{totalBackgroundImages:out.length,images:out};
  }`,

  images: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{images:[]};
    const images=[];
    section.querySelectorAll('img').forEach(img=>{const r=img.getBoundingClientRect();images.push({src:img.src,srcset:img.srcset||null,sizes:img.sizes||null,alt:img.alt||'',naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,renderedWidth:Math.round(r.width),renderedHeight:Math.round(r.height),loading:img.loading,decoding:img.decoding});});
    return{totalImages:images.length,images};
  }`,

  // NEW: per-element computed styles for structurally-significant elements
  computedStyles: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return[];
    const PROPS=['display','position','top','left','right','bottom','zIndex','flexDirection','flexWrap','justifyContent','alignItems','gap','gridTemplateColumns','gridTemplateRows','width','height','maxWidth','minWidth','maxHeight','marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textTransform','textAlign','color','backgroundColor','backgroundImage','backgroundSize','backgroundPosition','borderRadius','borderTopWidth','borderColor','borderStyle','boxShadow','opacity','transform','transition','overflow','objectFit','aspectRatio'];
    const path=(el)=>{const parts=[];let n=el;while(n&&n!==section&&parts.length<8){const p=n.parentElement;if(!p)break;const idx=[...p.children].indexOf(n)+1;parts.unshift(n.tagName.toLowerCase()+':nth-child('+idx+')');n=p;}return parts.join('>');};
    const significant=(el)=>{
      const t=el.tagName.toLowerCase();
      if(['h1','h2','h3','h4','h5','h6','p','a','button','img','svg','ul','ol','li','span','label','input'].includes(t))return true;
      const s=getComputedStyle(el);
      if(s.backgroundImage&&s.backgroundImage!=='none')return true;
      if(s.display==='flex'||s.display==='grid'||s.display==='inline-flex')return true;
      if(s.backgroundColor&&s.backgroundColor!=='rgba(0, 0, 0, 0)'&&s.backgroundColor!=='transparent')return true;
      if(s.boxShadow&&s.boxShadow!=='none')return true;
      return false;
    };
    const out=[];
    const els=[section,...section.querySelectorAll('*')];
    for(const el of els){
      if(el!==section&&!significant(el))continue;
      if(out.length>=120)break;
      const s=getComputedStyle(el);const r=el.getBoundingClientRect();
      const styles={};PROPS.forEach(p=>{const v=s[p];if(v&&v!=='none'&&v!=='normal'&&v!=='auto'&&v!=='0px'&&v!=='rgba(0, 0, 0, 0)')styles[p]=v;});
      out.push({path:el===section?':root':path(el),tag:el.tagName.toLowerCase(),id:el.id||null,cls:(el.className&&el.className.toString)?el.className.toString().split(' ').slice(0,3).join(' '):null,role:el.getAttribute&&el.getAttribute('role')||null,text:(el.childElementCount===0?(el.textContent||'').trim().slice(0,40):null),rect:{w:Math.round(r.width),h:Math.round(r.height)},styles});
    }
    return out;
  }`,

  scrollBehaviors: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return[];
    const out=[];
    section.querySelectorAll('*').forEach(el=>{const s=getComputedStyle(el);const lbl=el.tagName.toLowerCase()+(el.className&&el.className.toString?'.'+el.className.toString().split(' ')[0]:'');
      if(s.position==='sticky'||s.position==='fixed')out.push({element:lbl,trigger:'scroll',type:'sticky',position:s.position,top:s.top,zIndex:s.zIndex});
      if(s.opacity==='0'||(s.transform&&s.transform!=='none'&&s.transform.includes('translate')))out.push({element:lbl,trigger:'scroll',type:'reveal',opacity:s.opacity,transform:s.transform,transition:s.transition});
    });
    return out;
  }`,

  transitions: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return[];
    const out=[];
    section.querySelectorAll('*').forEach(el=>{const s=getComputedStyle(el);if(s.transition&&s.transition!=='all 0s ease 0s'&&s.transition!=='none')out.push({element:el.tagName.toLowerCase()+(el.className&&el.className.toString?'.'+el.className.toString().split(' ')[0]:''),transition:s.transition,animation:s.animation!=='none'?s.animation:null});});
    return out;
  }`,

  snippet: `(sectionSelector)=>{const s=document.querySelector(sectionSelector);return s?s.outerHTML:null;}`,

  // NEW (v2): @font-face rules → routing metadata. Actual woff2 download happens via
  // the network capture handler; this maps families to weights/format/google-vs-local.
  fontFaces: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    const usedFamilies=new Set();
    if(section)section.querySelectorAll('*').forEach(el=>{const f=getComputedStyle(el).fontFamily;if(f)f.split(',').forEach(x=>usedFamilies.add(x.trim().replace(/^["']|["']$/g,'').toLowerCase()));});
    const faces=[];
    for(const sheet of document.styleSheets){
      let rules;try{rules=sheet.cssRules||sheet.rules;}catch(e){faces.push({_corsBlocked:true,href:sheet.href});continue;}
      if(!rules)continue;
      for(let i=0;i<rules.length;i++){const rule=rules[i];
        if(rule.type===5){
          const fam=(rule.style.getPropertyValue('font-family')||'').replace(/^["']|["']$/g,'');
          const src=rule.style.getPropertyValue('src')||'';
          const urls=[...src.matchAll(/url\\(["']?([^"')]+)["']?\\)(?:\\s*format\\(["']?([^"')]+)["']?\\))?/g)].map(m=>({url:m[1],format:m[2]||null}));
          faces.push({fontFamily:fam,weight:rule.style.getPropertyValue('font-weight')||'400',style:rule.style.getPropertyValue('font-style')||'normal',display:rule.style.getPropertyValue('font-display')||null,unicodeRange:rule.style.getPropertyValue('unicode-range')||null,src:urls,used:usedFamilies.has(fam.toLowerCase()),isGoogle:/gstatic|googleapis/.test(src)});
        }
      }
    }
    return{usedFamilies:[...usedFamilies],fontFaces:faces};
  }`,

  // NEW (v2): CSS custom properties referenced by the section, with resolved values.
  // Lets Phase 2 PRESERVE vars (and detect Tailwind RGB-tuple vars) instead of inlining.
  cssVariables: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{variables:[]};
    const refs=new Map();
    const addRef=(n)=>{refs.set(n,(refs.get(n)||0)+1);};
    const collect=(cssText)=>{const m=cssText.match(/var\\((--[a-zA-Z0-9-_]+)/g);if(m)m.forEach(x=>addRef(x.replace('var(','')));};
    const els=[section,...section.querySelectorAll('*')];
    for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules;}catch(e){continue;}if(!rules)continue;
      const walk=(rs)=>{for(const r of rs){if(r.cssRules){walk(r.cssRules);continue;}if(!r.selectorText||!r.cssText.includes('var('))continue;let hit=false;try{hit=els.some(el=>el.matches&&el.matches(r.selectorText));}catch(e){}if(hit)collect(r.cssText);}};
      walk(rules);
    }
    // also catch inline-style var() usages
    els.forEach(el=>{const st=el.getAttribute&&el.getAttribute('style');if(st&&st.includes('var('))collect(st);});
    const rootStyle=getComputedStyle(document.documentElement);const secStyle=getComputedStyle(section);
    const variables=[...refs.entries()].map(([name,count])=>{
      let value=(rootStyle.getPropertyValue(name)||'').trim();
      if(!value)value=(secStyle.getPropertyValue(name)||'').trim();
      let kind='unknown';
      if(/^#|^rgb|^hsl/.test(value))kind='color';
      else if(/^-?[0-9.]+(px|rem|em|%|vh|vw|vmin|vmax)$/.test(value))kind='length';
      else if(/^[0-9.]+\\s+[0-9.]+\\s+[0-9.]+$/.test(value))kind='rgb-tuple';
      else if(/^-?[0-9.]+$/.test(value))kind='number';
      else if(value)kind='keyword';
      return{name,usageCount:count,value:value||null,valueKind:kind,isRgbTuple:kind==='rgb-tuple'};
    }).sort((a,b)=>b.usageCount-a.usageCount);
    return{totalVariables:variables.length,variables};
  }`,

  // NEW (v2): editor-flat content model — footer/nav link groups, social, contact.
  // Shaped flat ({text,href}[]) so the editor's flat-only objectArray never drops links.
  contentModel: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{linkGroups:[],socialLinks:[],contactItems:[],allLinks:[]};
    const clean=t=>(t||'').replace(/\\s+/g,' ').trim();
    const allLinks=[...section.querySelectorAll('a')].map(a=>({text:clean(a.textContent),href:a.getAttribute('href')||null,ariaLabel:a.getAttribute('aria-label')||null})).filter(l=>l.text||l.href);
    const seen=new Set();const linkGroups=[];
    section.querySelectorAll('ul,nav,div').forEach(container=>{
      let links;try{links=[...container.querySelectorAll(':scope > li > a, :scope > a')];}catch(e){return;}
      links=links.map(a=>({text:clean(a.textContent),href:a.getAttribute('href')||null})).filter(l=>l.text);
      if(links.length<2||links.length>20)return;
      const key=links.map(l=>l.text).join('|');if(seen.has(key))return;seen.add(key);
      let heading='';const prev=container.previousElementSibling;
      if(prev&&/^(H[1-6]|SPAN|P|STRONG|B)$/.test(prev.tagName)&&clean(prev.textContent).length<40)heading=clean(prev.textContent);
      if(!heading){const h=container.parentElement&&container.parentElement.querySelector('h1,h2,h3,h4,h5,h6');if(h&&clean(h.textContent).length<40)heading=clean(h.textContent);}
      linkGroups.push({heading:heading||null,links});
    });
    const socialLinks=allLinks.filter(l=>/facebook|instagram|twitter|x\\.com|youtube|linkedin|tiktok|pinterest|whatsapp|t\\.me|telegram/i.test(l.href||''));
    const contactItems=[];
    section.querySelectorAll('a[href^="tel:"],a[href^="mailto:"]').forEach(a=>contactItems.push({type:a.getAttribute('href').startsWith('tel:')?'phone':'email',value:clean(a.textContent)||a.getAttribute('href'),href:a.getAttribute('href')}));
    return{linkGroups,socialLinks,contactItems,allLinks:allLinks.slice(0,200)};
  }`,

  // NEW (v2): JS-animation fingerprint — libraries, @keyframes, AOS attrs, live anims, carousels.
  jsAnimations: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);const w=window;
    const libraries=[];
    const sig={AOS:()=>!!w.AOS||!!document.querySelector('[data-aos]'),GSAP:()=>!!w.gsap||!!w.TweenMax||!!w.TweenLite,Framer:()=>!!document.querySelector('[data-framer-name],[data-projection-id]'),Lottie:()=>!!w.lottie||!!w.bodymovin||!!document.querySelector('lottie-player,[data-animation-path]'),Swiper:()=>!!w.Swiper||!!document.querySelector('.swiper,.swiper-container'),Splide:()=>!!w.Splide||!!document.querySelector('.splide'),Slick:()=>!!document.querySelector('.slick-slider,.slick-initialized'),Glide:()=>!!w.Glide||!!document.querySelector('.glide'),Owl:()=>!!document.querySelector('.owl-carousel'),Locomotive:()=>!!w.LocomotiveScroll||!!document.querySelector('[data-scroll-container]'),Marquee:()=>!!document.querySelector('marquee,.marquee,[class*="marquee"]')};
    Object.entries(sig).forEach(([n,f])=>{try{if(f())libraries.push(n);}catch(e){}});
    const keyframes=[];
    for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules;}catch(e){continue;}if(!rules)continue;
      for(let i=0;i<rules.length;i++){const r=rules[i];if(r.type===7){if(keyframes.length<40)keyframes.push({name:r.name,cssText:r.cssText.slice(0,600)});}}}
    const aos=[];
    if(section)section.querySelectorAll('[data-aos]').forEach(el=>{if(aos.length<30)aos.push({selector:el.tagName.toLowerCase()+(el.className&&el.className.toString?'.'+el.className.toString().split(' ')[0]:''),animation:el.getAttribute('data-aos'),duration:el.getAttribute('data-aos-duration'),delay:el.getAttribute('data-aos-delay'),easing:el.getAttribute('data-aos-easing')});});
    let liveAnimations=[];
    try{const anims=(section||document).getAnimations?(section||document).getAnimations():[];liveAnimations=anims.slice(0,30).map(a=>{const tgt=a.effect&&a.effect.target;const kf=a.effect&&a.effect.getKeyframes?a.effect.getKeyframes():[];return{name:a.animationName||(a.constructor&&a.constructor.name)||'anim',playState:a.playState,target:tgt?tgt.tagName.toLowerCase()+(tgt.className&&tgt.className.toString?'.'+tgt.className.toString().split(' ')[0]:''):null,keyframeCount:kf.length};});}catch(e){}
    const carousels=[];
    if(section)section.querySelectorAll('.swiper,.splide,.slick-slider,.glide,.owl-carousel,[data-carousel]').forEach(el=>{if(carousels.length<10)carousels.push({selector:(el.className&&el.className.toString)?'.'+el.className.toString().split(' ').slice(0,2).join('.'):el.tagName.toLowerCase(),slideCount:el.querySelectorAll('.swiper-slide,.splide__slide,.slick-slide,.glide__slide,[data-slide]').length});});
    return{libraries,keyframes,aos,liveAnimations,carousels};
  }`,

  // NEW (v2): reveal candidates — interactive triggers + statically-hidden dropdown/modal HTML.
  // Captures CSS-hidden panels already in the DOM (display:none submenus, mega-menus, modals).
  // JS/portal reveals that mount only on click are NOT here — they stay the MCP agent's job.
  revealCandidates: `(sectionSelector)=>{
    const section=document.querySelector(sectionSelector);
    if(!section)return{triggers:[],hiddenPanels:[]};
    const clean=t=>(t||'').replace(/\\s+/g,' ').trim();
    const triggers=[];
    section.querySelectorAll('[aria-haspopup],[aria-expanded],[aria-controls],button,[role="button"]').forEach(el=>{if(triggers.length<40)triggers.push({tag:el.tagName.toLowerCase(),text:clean(el.textContent).slice(0,30),hasPopup:el.getAttribute('aria-haspopup'),expanded:el.getAttribute('aria-expanded'),controls:el.getAttribute('aria-controls')||null});});
    const hiddenPanels=[];
    const candidates=section.querySelectorAll('[hidden],[aria-hidden="true"],[role="menu"],[role="dialog"],[class*="dropdown"],[class*="submenu"],[class*="mega"],[class*="modal"],[class*="drawer"],[class*="flyout"],[class*="popover"]');
    candidates.forEach(el=>{
      if(hiddenPanels.length>=20)return;
      const s=getComputedStyle(el);
      const hidden=s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0||el.hasAttribute('hidden');
      if(!hidden)return;
      const html=el.outerHTML;
      if(html.length<=20||html.length>8000)return;
      hiddenPanels.push({selector:el.tagName.toLowerCase()+((el.className&&el.className.toString)?'.'+el.className.toString().split(' ').slice(0,2).join('.'):''),id:el.id||null,reason:s.display==='none'?'display-none':s.visibility==='hidden'?'visibility-hidden':parseFloat(s.opacity)===0?'opacity-0':'hidden-attr',outerHTML:html});
    });
    return{triggers,hiddenPanels};
  }`,
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
