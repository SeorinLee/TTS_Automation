const http = require('http');
const { URL, URLSearchParams } = require('url');
const { chromium, firefox } = require('./_internal/playwright/driver/package');

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOSTNAME || '127.0.0.1';
const BUILD_ID = 'firefox-germany-v45';

const state = {
  browser: null,
  browserKind: null,
  activeProfiles: new Map(),
  jobs: new Map(),
  nextJobId: 1,
  nextRunId: 1,
};

function getSellerFlowUrls(profileCode) {
  const code = String(profileCode || 'US_CHROME');
  const isUs = code.startsWith('US_');
  const isGermany = code.startsWith('DE_');

  if (isUs) {
    return {
      login: 'https://seller-us.tiktok.com/account/login?channel=tts_login&register_chain=https%3A%2F%2Fseller-us.tiktok.com%2Faccount%2Fregister&register_referrer=https%3A%2F%2Faffiliate-us.tiktok.com%2F',
      loginSuccess: 'https://seller-us.tiktok.com/affiliate/landing?shop_region=US',
      affiliateEntry: 'https://affiliate-us.tiktok.com/affiliate/collaboration/target-invitation?shop_region=US&route_migration=1&tab=1',
      findCreators: 'https://affiliate-us.tiktok.com/connection/creator?shop_region=US',
      market: 'US',
      host: 'seller-us.tiktok.com',
    };
  }

  if (isGermany) {
    return {
      login: 'https://seller-eu.tiktok.com/account/login?shop_region=DE',
      loginSuccess: 'https://seller-eu.tiktok.com/affiliate/landing?shop_region=DE',
      affiliateEntry: 'https://affiliate.tiktok.com/connection/target-invitation?shop_region=DE',
      findCreators: 'https://affiliate.tiktok.com/connection/creator?shop_region=DE',
      market: 'DE',
      host: 'seller-eu.tiktok.com',
    };
  }

  return {
    login: 'https://seller-uk.tiktok.com/account/login?channel=tts_login&register_chain=https%3A%2F%2Fseller-uk.tiktok.com%2Faccount%2Fregister&register_referrer=https%3A%2F%2Faffiliate.tiktok.com%2F',
    loginSuccess: 'https://seller-uk.tiktok.com/affiliate/landing?shop_region=GB',
    affiliateEntry: 'https://affiliate.tiktok.com/connection/target-invitation?shop_region=GB',
    findCreators: 'https://affiliate.tiktok.com/connection/creator?shop_region=GB',
    market: 'GB',
    host: 'seller-uk.tiktok.com',
  };
}

const DEFAULT_PROFILES = ['US', 'UK', 'DE'].flatMap((market) =>
  [
    ['CHROME', 'Chrome'],
    ['EDGE', 'Edge'],
    ['FIREFOX', 'Firefox'],
  ].map(([browserCode, browser]) => ({
    profile_code: `${market}_${browserCode}`,
    browser,
    market,
    status: 'connected',
    last_login_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  })),
);

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseUrlEncoded(body) {
  const params = new URLSearchParams(body);
  const result = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

function parseMultipartForm(body, contentType) {
  const match = /boundary=(.*)$/i.exec(contentType || '');
  if (!match) return {};
  const boundary = `--${match[1].trim()}`;
  const parts = body.split(boundary).slice(1, -1);
  const result = {};

  for (const part of parts) {
    const block = part.trim();
    if (!block || block === '--') continue;
    const headerEnd = block.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = block.slice(0, headerEnd);
    const content = block.slice(headerEnd + 4).replace(/\r\n$/, '');
    const nameMatch = /name="([^"]+)"/i.exec(header);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const value = content;
    result[name] = value;
  }

  return result;
}

function resolveProfileRecord(profileCode) {
  return DEFAULT_PROFILES.find((profile) => profile.profile_code === profileCode) || {
    profile_code: profileCode,
    browser: profileCode.endsWith('CHROME') ? 'Chrome' : profileCode.endsWith('FIREFOX') ? 'Firefox' : 'Edge',
    market: profileCode.startsWith('US_') ? 'US' : profileCode.startsWith('DE_') ? 'DE' : 'UK',
    status: 'connected',
    last_login_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  };
}

async function launchBrowserForProfile(profileCode) {
  const browserKind = String(profileCode || 'US_CHROME').endsWith('FIREFOX') ? 'firefox' :
    String(profileCode || 'US_CHROME').endsWith('EDGE') ? 'edge' : 'chrome';
  if (state.browser && state.browserKind === browserKind) return state.browser;
  if (state.browser) {
    await state.browser.close();
    state.browser = null;
    state.browserKind = null;
  }

  const chromiumArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1200'];
  const launchCandidates = browserKind === 'firefox'
    ? [{ headless: false }]
    : browserKind === 'edge'
      ? [{ channel: 'msedge', headless: false, args: chromiumArgs }, { headless: false, args: chromiumArgs }]
      : [{ channel: 'chrome', headless: false, args: chromiumArgs }, { headless: false, args: chromiumArgs }];
  const browserType = browserKind === 'firefox' ? firefox : chromium;

  let lastError = null;
  for (const candidate of launchCandidates) {
    try {
      const browser = await browserType.launch(candidate);
      state.browser = browser;
      state.browserKind = browserKind;
      return browser;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to launch ${browserKind} for macOS automation`);
}

async function ensureBrowser(profileCode) {
  try {
    await launchBrowserForProfile(profileCode);
    return true;
  } catch (error) {
    console.error('[mac-worker] browser launch failed:', error.message);
    return false;
  }
}

async function openSellerLoginFlow(profileCode) {
  const browser = await launchBrowserForProfile(profileCode);
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const flow = getSellerFlowUrls(profileCode);
  await page.goto(flow.login, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const url = page.url();
  const bodyText = (await page.locator('body').innerText()).trim().toLowerCase();
  const isLoggedIn = /seller-.*tiktok\.com\/affiliate\/landing|shop_region=|seller dashboard|affiliate landing/.test(url) || /affiliate landing|shop region|seller dashboard/.test(bodyText);

  const status = isLoggedIn ? 'connected' : 'login_required';
  state.activeProfiles.set(profileCode, status);

  return {
    ok: true,
    profile_code: profileCode,
    status,
    url,
    login_url: flow.login,
    landing_url: flow.loginSuccess,
    affiliate_entry_url: flow.affiliateEntry,
  };
}

function createJobFromForm(formData) {
  const profileCode = formData.profile_code || 'US_CHROME';
  const invitationText = formData.invitation_text || formData['invitation_text[]'] || '';
  const jobId = `job-mac-${state.nextJobId++}`;

  const job = {
    id: jobId,
    profile_code: profileCode,
    status: 'queued',
    current: '대기 중',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    invitation_text: invitationText,
    logs: [{ time: new Date().toISOString(), status: 'queued', message: `Mac worker ready for ${profileCode}` }],
    invitation_creator_rows: [],
    invitation_accept_states: [],
    search_page: 0,
    current_phase: 'search',
  };

  state.jobs.set(jobId, job);
  return job;
}

function parseMultiPartOrFormEncoded(req, rawBody, contentType) {
  if (!contentType) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(rawBody || '{}'); } catch { return {}; }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) return parseUrlEncoded(rawBody);
  if (contentType.includes('multipart/form-data')) return parseMultipartForm(rawBody, contentType);
  return {};
}

function parseInvitationNameEditText(rawText, manualLastNumber) {
  const tokens = String(rawText || '').split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean);
  const seen = new Set();
  const items = [];
  const errors = [];

  tokens.forEach((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    const rangeMatch = name.match(/^(.*?)_(\d+)~(\d+)$/);
    if (rangeMatch) {
      const [, prefix, startStr, endStr] = rangeMatch;
      const start = Number(startStr);
      const end = Number(endStr);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > 5000) {
        errors.push(`올바르지 않은 범위: ${name}`);
        return;
      }
      for (let number = start; number <= end; number += 1) {
        const token = `${prefix}_${number}`;
        if (seen.has(token.toLowerCase())) continue;
        seen.add(token.toLowerCase());
        const nextNumber = Number.isInteger(manualLastNumber) ? manualLastNumber + 1 : null;
        items.push({
          order: items.length + 1,
          base_name: token,
          owner: prefix,
          product: token.split('_')[1] || token,
          date: token.split('_').slice(-2, -1)[0] || 'AUTO',
          search_query: token,
          manual_last_number: manualLastNumber,
          next_number: nextNumber,
        });
      }
      return;
    }

    const match = name.match(/^(.*?)_([^_]+)_([^_]+)_$/);
    if (!match || !match[1]) {
      errors.push(`형식을 확인해주세요: ${name} (예: D_테스트_0914_)`);
      return;
    }
    const [, owner, product, date] = match;
    seen.add(key);
    const nextNumber = Number.isInteger(manualLastNumber) ? manualLastNumber + 1 : null;
    items.push({
      order: items.length + 1,
      base_name: name,
      owner,
      product,
      date,
      search_query: product + '_' + date,
      manual_last_number: manualLastNumber,
      next_number: nextNumber,
    });
  });

  return { items, errors };
}

function parseInvitationAcceptText(rawText) {
  const tokens = String(rawText || '').split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean);
  const items = [];
  const errors = [];
  const names = [];

  tokens.forEach((token) => {
    const rangeMatch = token.match(/^(.*?)_(\d+)~(\d+)$/);
    if (!rangeMatch) {
      names.push(token);
      return;
    }
    const [, prefix, startStr, endStr] = rangeMatch;
    const start = Number(startStr);
    const end = Number(endStr);
    if (start > end || end - start > 5000) {
      errors.push(`올바르지 않은 범위: ${token}`);
      return;
    }
    for (let number = start; number <= end; number += 1) {
      names.push(`${prefix}_${number}`);
    }
  });

  const seen = new Set();
  names.forEach((name) => {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return;
    const match = name.match(/^(.*?)_([^_]+)_([^_]+)_(\d+)$/);
    if (!match || !match[1]) {
      errors.push(`형식을 확인해주세요: ${name} (예: PJH_SZP_0810_1)`);
      return;
    }
    const [, owner, product, date, number] = match;
    seen.add(lower);
    items.push({
      order: items.length + 1,
      invitation_name: name,
      owner,
      product,
      date,
      number,
      keyword: `${product}_${date}`,
    });
  });

  return { items, errors };
}

function createInvitationNameEditJob(formData) {
  const profileCode = formData.profile_code || 'US_CHROME';
  const rawText = formData.invitation_text || formData.invitationText || '';
  const manualLastNumber = Number(formData.last_number || formData.lastNumber || 0);
  const jobId = `invitation-name-edit-${state.nextJobId++}`;
  const parsed = parseInvitationNameEditText(rawText, Number.isFinite(manualLastNumber) ? manualLastNumber : null);

  const job = {
    id: jobId,
    profile_code: profileCode,
    status: 'queued',
    current: '대기 중',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    invitation_text: rawText,
    last_number: Number.isFinite(manualLastNumber) ? manualLastNumber : null,
    items: parsed.items,
    logs: [{ time: new Date().toISOString(), status: 'queued', message: `초대장 이름수정 작업이 생성되었습니다. (${profileCode})` }],
    invitation_name_edit_rows: parsed.items.map((item) => ({
      order: item.order,
      base_name: item.base_name,
      original_name: item.base_name,
      new_name: null,
      number: item.next_number,
      status: 'QUEUED',
      message: '대기 중',
    })),
    invitation_name_edit_groups: [{
      id: 'default',
      discovered_total: parsed.items.length,
      completed_count: 0,
      remaining_count: parsed.items.length,
      status: 'QUEUED',
    }],
    current_number: null,
    current_original_name: null,
    current_new_name: null,
    search_page: 0,
    current_phase: 'search',
    errors: parsed.errors,
  };

  state.jobs.set(jobId, job);
  return job;
}

function createInvitationAcceptJob(formData) {
  const profileCode = formData.profile_code || 'US_CHROME';
  const rawText = formData.invitation_text || formData.invitationText || '';
  const jobId = `invitation-accept-${state.nextJobId++}`;
  const parsed = parseInvitationAcceptText(rawText);

  const job = {
    id: jobId,
    profile_code: profileCode,
    status: 'queued',
    current: '대기 중',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    invitation_text: rawText,
    logs: [{ time: new Date().toISOString(), status: 'queued', message: `초대장 조회 작업이 생성되었습니다. (${profileCode})` }],
    invitation_accept_states: parsed.items.map((item) => ({
      order: item.order,
      name: item.invitation_name,
      status: 'QUEUED',
      keyword: item.keyword,
      creator: null,
      result: null,
    })),
    invitation_creator_rows: parsed.items.map((item) => ({
      keyword: item.keyword,
      invitation_name: item.invitation_name,
      creator: null,
      nickname: null,
      creator_id: null,
      region: null,
      added_products: false,
      posted_content: false,
      sample_sent: false,
      status: 'QUEUED',
    })),
    current_phase: 'search',
    search_page: 0,
    search_total_pages: 0,
    errors: parsed.errors,
  };

  state.jobs.set(jobId, job);
  return job;
}

function applyJobAction(job, action) {
  if (!job) return { ok: false, error: 'job_not_found' };

  switch (action) {
    case 'pause':
      job.status = 'paused';
      job.current = '일시정지';
      job.logs.push({ time: new Date().toISOString(), status: 'paused', message: '작업이 일시 정지되었습니다.' });
      return { ok: true, status: 'paused' };
    case 'resume':
      job.status = 'queued';
      job.current = '재개 대기 중';
      job.logs.push({ time: new Date().toISOString(), status: 'queued', message: '작업을 다시 시작합니다.' });
      return { ok: true, status: 'queued' };
    case 'cancel':
      job.status = 'cancelled';
      job.current = '취소됨';
      job.logs.push({ time: new Date().toISOString(), status: 'cancelled', message: '작업이 취소되었습니다.' });
      return { ok: true, status: 'cancelled' };
    case 'retry':
      job.status = 'queued';
      job.current = '재시도 대기 중';
      job.logs.push({ time: new Date().toISOString(), status: 'queued', message: '오류 항목을 다시 시도합니다.' });
      return { ok: true, status: 'queued' };
    default:
      return { ok: false, error: 'unsupported_action' };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processInvitationJob(jobId, kind) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'running';
    job.current = kind === 'invitation-accept' ? '초대장 조회 실행 중' : '초대장 이름수정 실행 중';
    job.logs.push({ time: new Date().toISOString(), status: 'running', message: `${kind === 'invitation-accept' ? '초대장 조회' : '초대장 이름수정'} 자동화 시작` });
    job.updated_at = new Date().toISOString();

    const browser = await launchBrowserForProfile(job.profile_code || 'US_CHROME');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });

      const flow = getSellerFlowUrls(job.profile_code || 'US_CHROME');
    const loginUrl = flow.login;
    const landingUrl = flow.loginSuccess;
    const affiliateEntryUrl = flow.affiliateEntry;
    const creatorsUrl = flow.findCreators;

    job.logs.push({ time: new Date().toISOString(), status: 'running', message: `Windows flow 기준 seller 로그인 경로를 엽니다: ${loginUrl}` });
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    const pageUrl = page.url();
    const pageText = (await page.locator('body').innerText()).trim();
    const pageTextLower = pageText.toLowerCase();
    const isLoginPage = /seller-.*tiktok\.com\/account\/login|tiktok\.com\/login|log in|login|sign in/i.test(pageUrl) || /log in|login|sign in/.test(pageTextLower);
    const isSellerLanding = /seller-.*tiktok\.com\/affiliate\/landing|shop_region=/.test(pageUrl) || /affiliate landing|shop region|seller dashboard/i.test(pageTextLower);
    const isAffiliatePage = /affiliate-us\.tiktok\.com|affiliate\.tiktok\.com|target-invitation|connection\/creator/.test(pageUrl) || /target invitation|creator search|connection/i.test(pageTextLower);

    if (isLoginPage && !isSellerLanding && !isAffiliatePage) {
      job.status = 'needs_login';
      job.current = '로그인 필요';
      job.logs.push({ time: new Date().toISOString(), status: 'needs_login', message: 'Windows 기준 seller 로그인 페이지가 열렸습니다. 실제 TikTok seller 계정으로 로그인 후 다시 실행하세요.' });
      job.updated_at = new Date().toISOString();
      await page.close();
      return;
    }

    if (!isSellerLanding && !isAffiliatePage) {
      job.status = 'needs_login';
      job.current = '로그인 필요';
      job.logs.push({ time: new Date().toISOString(), status: 'needs_login', message: `Windows flow와 동일하게 seller 세션 확인이 필요합니다. 로그인 완료 후 ${landingUrl} 경로를 통과해야 합니다.` });
      job.updated_at = new Date().toISOString();
      await page.close();
      return;
    }

    job.logs.push({ time: new Date().toISOString(), status: 'running', message: `Seller / Affiliate flow 확인됨. landing=${landingUrl}, affiliate=${affiliateEntryUrl}, creators=${creatorsUrl}` });
    job.updated_at = new Date().toISOString();

    if (kind === 'invitation-accept') {
      job.status = 'needs_login';
      job.current = '실제 affiliate 페이지 연결 대기';
      job.logs.push({ time: new Date().toISOString(), status: 'needs_login', message: 'Windows와 동일하게 실제 affiliate target invitation 페이지에 들어온 뒤에 creator 조회가 시작됩니다.' });
      job.updated_at = new Date().toISOString();
      await page.close();
      return;
    }

    job.status = 'needs_login';
    job.current = '실제 seller 페이지 검증 대기';
    job.logs.push({ time: new Date().toISOString(), status: 'needs_login', message: 'Windows 기준 이름수정 automation은 실제 seller 페이지 검증 이후에만 실행됩니다. 로그인 후 다시 시도하세요.' });
    job.updated_at = new Date().toISOString();
    await page.close();
  } catch (error) {
    const jobCurrent = state.jobs.get(jobId);
    if (!jobCurrent) return;
    jobCurrent.status = 'failed';
    jobCurrent.current = '오류 발생';
    jobCurrent.logs.push({ time: new Date().toISOString(), status: 'failed', message: error.message || 'execution_failed' });
    jobCurrent.updated_at = new Date().toISOString();
  }
}

async function handleRequest(req, res) {
  if (req.method.toUpperCase() === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const method = req.method.toUpperCase();

  if (url.pathname === '/health') {
    const browserAvailable = !!state.browser;
    json(res, 200, {
      ok: true,
      worker: 'connected',
      build: BUILD_ID,
      browser: browserAvailable ? 'ready' : 'idle',
      web_build: 'portable-v1',
      node_env: 'production',
      platform: process.platform,
      version: process.version,
    });
    return;
  }

  if (url.pathname === '/status') {
    json(res, 200, {
      ok: true,
      platform: process.platform,
      port: PORT,
      mode: 'macos-worker',
      browser: !!state.browser,
    });
    return;
  }

  if (url.pathname === '/profiles') {
    const profiles = DEFAULT_PROFILES.map((profile) => ({
      ...profile,
      status: state.activeProfiles.get(profile.profile_code) || profile.status,
    }));
    json(res, 200, profiles);
    return;
  }

  const profilesMatch = /^\/profiles\/([^/]+)\/(login|verify|reset)$/.exec(url.pathname);
  if (profilesMatch) {
    const [, profileCode, action] = profilesMatch;
    const profile = resolveProfileRecord(profileCode);

    if (action === 'login') {
      try {
        const result = await openSellerLoginFlow(profileCode);
        json(res, 200, { ok: true, ...result, profile });
        return;
      } catch (error) {
        state.activeProfiles.set(profileCode, 'error');
        json(res, 502, { ok: false, profile_code: profileCode, status: 'error', detail: error.message || 'login_failed', profile });
        return;
      }
    }

    if (action === 'verify') {
      try {
        const browserReady = await ensureBrowser(profileCode);
        const profileStatus = browserReady ? 'connected' : 'error';
        state.activeProfiles.set(profileCode, profileStatus);
        json(res, 200, { ok: browserReady, profile_code: profileCode, status: profileStatus, profile });
        return;
      } catch (error) {
        state.activeProfiles.set(profileCode, 'error');
        json(res, 200, { ok: false, profile_code: profileCode, status: 'error', detail: error.message, profile });
        return;
      }
    }

    if (action === 'reset') {
      if (state.browser) {
        await state.browser.close();
        state.browser = null;
        state.browserKind = null;
      }
      state.activeProfiles.set(profileCode, 'login_required');
      json(res, 200, { ok: true, profile_code: profileCode, status: 'login_required' });
      return;
    }
  }

  if (url.pathname === '/jobs') {
    if (method === 'GET') {
      json(res, 200, Array.from(state.jobs.values()));
      return;
    }

    if (method === 'POST') {
      const raw = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      const formData = parseMultiPartOrFormEncoded(req, raw, contentType);
      const job = createJobFromForm(formData);
      json(res, 200, { ok: true, id: job.id, job_id: job.id, job, status: 'queued' });
      return;
    }
  }

  const jobMatch = /^\/jobs\/([^/]+)(?:\/(cancel|retry|download))?$/.exec(url.pathname);
  if (jobMatch) {
    const [, jobId, action] = jobMatch;
    const job = state.jobs.get(jobId);
    if (!job) {
      json(res, 404, { detail: 'Job not found', code: 'JOB_NOT_FOUND' });
      return;
    }

    if (action === 'cancel') {
      job.status = 'cancelled';
      job.updated_at = new Date().toISOString();
      json(res, 200, { ok: true, job_id: jobId, status: 'cancelled' });
      return;
    }

    if (action === 'retry') {
      job.status = 'queued';
      job.updated_at = new Date().toISOString();
      json(res, 200, { ok: true, job_id: jobId, status: 'queued' });
      return;
    }

    if (action === 'download') {
      json(res, 200, { ok: true, job_id: jobId, file: 'not_available_on_mac_stub' });
      return;
    }

    json(res, 200, job);
    return;
  }

  if (url.pathname === '/invitation-name-edit/parse') {
    if (method !== 'POST') {
      json(res, 405, { detail: 'Method not allowed' });
      return;
    }
    const raw = await readBody(req);
    const body = parseMultiPartOrFormEncoded(req, raw, req.headers['content-type'] || '');
    const text = (body.invitation_text || body.invitationText || '').toString();
    const manualLastNumber = Number.isFinite(Number(body.last_number || body.lastNumber)) ? Number(body.last_number || body.lastNumber) : null;
    const parsed = parseInvitationNameEditText(text, manualLastNumber);
    json(res, 200, { items: parsed.items, errors: parsed.errors });
    return;
  }

  if (url.pathname === '/invitation-name-edit-jobs') {
    if (method === 'GET') {
      json(res, 200, Array.from(state.jobs.values()).filter((job) => job.id.startsWith('invitation-name-edit-')));
      return;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const body = parseMultiPartOrFormEncoded(req, raw, req.headers['content-type'] || '');
      const job = createInvitationNameEditJob(body);
      process.nextTick(() => processInvitationJob(job.id, 'invitation-name-edit'));
      json(res, 200, { ok: true, job_id: job.id, id: job.id, job, status: 'queued' });
      return;
    }
  }

  const invitationNameEditMatch = /^\/invitation-name-edit-jobs\/([^/]+)(?:\/(pause|resume|cancel|retry|download))?$/.exec(url.pathname);
  if (invitationNameEditMatch) {
    const [, jobId, action] = invitationNameEditMatch;
    const job = state.jobs.get(jobId);

    if (!job) {
      json(res, 404, { detail: 'Job not found', code: 'JOB_NOT_FOUND' });
      return;
    }

    if (action === 'download') {
      json(res, 200, { ok: true, job_id: jobId, file: `invitation-name-edit-${jobId}.csv`, rows: job.invitation_name_edit_rows || [] });
      return;
    }

    if (action) {
      const result = applyJobAction(job, action);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, job_id: jobId, status: job.status, job } : { ok: false, detail: result.error });
      return;
    }

    json(res, 200, job);
    return;
  }

  if (url.pathname === '/invitation-accept-jobs') {
    if (method === 'GET') {
      json(res, 200, Array.from(state.jobs.values()).filter((job) => job.id.startsWith('invitation-accept-')));
      return;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const body = parseMultiPartOrFormEncoded(req, raw, req.headers['content-type'] || '');
      const job = createInvitationAcceptJob(body);
      process.nextTick(() => processInvitationJob(job.id, 'invitation-accept'));
      json(res, 200, { ok: true, job_id: job.id, id: job.id, job, status: 'queued' });
      return;
    }
  }

  const invitationAcceptMatch = /^\/invitation-accept-jobs\/([^/]+)(?:\/(pause|resume|cancel|retry|download))?$/.exec(url.pathname);
  if (invitationAcceptMatch) {
    const [, jobId, action] = invitationAcceptMatch;
    const job = state.jobs.get(jobId);

    if (!job) {
      json(res, 404, { detail: 'Job not found', code: 'JOB_NOT_FOUND' });
      return;
    }

    if (action === 'download') {
      json(res, 200, { ok: true, job_id: jobId, file: `invitation-accept-${jobId}.csv`, rows: job.invitation_creator_rows || [] });
      return;
    }

    if (action) {
      const result = applyJobAction(job, action);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, job_id: jobId, status: job.status, job } : { ok: false, detail: result.error });
      return;
    }

    json(res, 200, job);
    return;
  }

  json(res, 404, { ok: false, error: 'not_found', path: url.pathname });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[mac-worker] request failed:', error);
    json(res, 500, { ok: false, detail: error.message || 'internal_error' });
  });
});

server.listen(PORT, HOST, async () => {
  console.log(`[mac-worker] listening on http://${HOST}:${PORT}`);
  try {
    const browser = await launchBrowserForProfile('US_CHROME');
    console.log('[mac-worker] browser ready:', !!browser);
  } catch (error) {
    console.log('[mac-worker] browser not ready:', error.message);
  }
});

process.on('SIGINT', async () => {
  if (state.browser) await state.browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (state.browser) await state.browser.close();
  process.exit(0);
});
