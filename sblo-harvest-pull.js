const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN_ENV_KEYS = ['HUBSPOT_TOKEN','HUBSPOT_PRIVATE_APP_TOKEN','HUBSPOT_ACCESS_TOKEN','HS_TOKEN','HUBSPOT_API_KEY','HAPIKEY'];
const HS_TOKEN = TOKEN_ENV_KEYS.map(k => process.env[k]).find(Boolean);
if (!HS_TOKEN) { console.error('FATAL: no HubSpot token found in env (checked ' + TOKEN_ENV_KEYS.join(', ') + ')'); process.exit(1); }

const OWNER_ID = '83186604';

function hsFetch(reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com', path: reqPath, method,
      headers: Object.assign(
        { 'Authorization': 'Bearer ' + HS_TOKEN, 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, res => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({ _raw: raw, _status: res.statusCode }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function searchAllGCs() {
  let results = []; let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: 'bd_audience', operator: 'EQ', value: 'gc' },
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: OWNER_ID },
        { propertyName: 'cleararmor_fit_score', operator: 'HAS_PROPERTY' }
      ]}],
      properties: ['name', 'domain', 'cleararmor_fit_score'],
      sorts: [{ propertyName: 'cleararmor_fit_score', direction: 'DESCENDING' }],
      limit: 100
    };
    if (after) body.after = after;
    const resp = await hsFetch('/crm/v3/objects/companies/search', 'POST', body);
    if (!resp.results) { console.error('SEARCH FAILED:', JSON.stringify(resp).slice(0,500)); break; }
    results = results.concat(resp.results);
    after = resp.paging && resp.paging.next ? resp.paging.next.after : undefined;
  } while (after);
  return results;
}

async function batchAssociations(companyIds) {
  const map = {};
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const body = { inputs: chunk.map(id => ({ id })) };
    const resp = await hsFetch('/crm/v4/associations/companies/contacts/batch/read', 'POST', body);
    if (resp.results) {
      resp.results.forEach(r => { map[r.from.id] = (r.to || []).map(t => t.toObjectId); });
    }
  }
  return map;
}

async function batchContactTitles(contactIds) {
  const map = {};
  const uniq = [...new Set(contactIds)];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const body = { properties: ['jobtitle'], inputs: chunk.map(id => ({ id })) };
    const resp = await hsFetch('/crm/v3/objects/contacts/batch/read', 'POST', body);
    if (resp.results) resp.results.forEach(r => { map[r.id] = (r.properties && r.properties.jobtitle) || ''; });
  }
  return map;
}

const DOOR_RE = /diversity|SBLO|small business liaison|supplier diversity|DBE|MBE|WBE|D\/M\/WBE/i;
function hasDoor(contactIds, titleMap) {
  return contactIds.some(id => DOOR_RE.test(titleMap[id] || ''));
}

const CANDIDATE_PATHS = ['', '/diversity', '/supplier-diversity', '/suppliers', '/about/diversity',
  '/diversity-equity-inclusion', '/community/diversity', '/about-us/diversity', '/careers/diversity', '/company/diversity'];
const ROLE_RE = /(Supplier Diversity|Small Business Liaison|SBLO|Diversity[, ]+(Equity|Inclusion)|DBE\/MBE\/WBE Coordinator|Business Diversity)/i;
const NAME_NEAR_RE = /([A-Z][a-z]+(?:\s[A-Z]\.?)?\s[A-Z][a-zA-Z'-]+)[\s\S]{0,80}?(Supplier Diversity[^.\n]{0,60}|Small Business Liaison[^.\n]{0,60}|SBLO[^.\n]{0,60}|Diversity[^.\n]{0,60})/;

async function crawlCompany(browser, domain) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
  let hit = null;
  for (const p of CANDIDATE_PATHS) {
    const url = 'https://' + domain + p;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text = await page.evaluate(() => document.body ? document.body.innerText : '');
      if (ROLE_RE.test(text)) {
        const m = text.match(NAME_NEAR_RE);
        hit = { url, snippet: text.slice(0, 4000), nameGuess: m ? m[1] : '', roleGuess: m ? m[2] : ((text.match(ROLE_RE) || [''])[0]) };
        break;
      }
    } catch (e) { /* try next path */ }
  }
  await page.close().catch(()=>{});
  return hit;
}

function toCsv(rows, cols) {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function pushToGithub(token, filename, content) {
  const body = JSON.stringify({ message: 'harvest ' + filename, content: Buffer.from(content).toString('base64') });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/exafsp/vd-drop/contents/' + filename, method: 'PUT',
      headers: { 'Authorization': 'token ' + token, 'User-Agent': 'vd-sblo-harvest', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve({ status: res.statusCode, body: raw })); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  const startedAt = Date.now();
  console.log('Pulling GC cohort from HubSpot (bd_audience=gc, owner=' + OWNER_ID + ', fit-scored)...');
  const companies = await searchAllGCs();
  console.log('Total GC companies: ' + companies.length);

  const ids = companies.map(c => c.id);
  console.log('Pulling company->contact associations...');
  const assocMap = await batchAssociations(ids);
  const allContactIds = Object.values(assocMap).flat();
  console.log('Pulling contact job titles (' + allContactIds.length + ' contacts)...');
  const titleMap = await batchContactTitles(allContactIds);

  const gaps = companies.filter(c => !hasDoor(assocMap[c.id] || [], titleMap));
  console.log('Companies WITHOUT an existing SBLO/diversity door: ' + gaps.length + ' of ' + companies.length);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  const found = [];
  const manual = [];
  let done = 0;
  for (const c of gaps) {
    const domain = c.properties.domain;
    if (!domain) { manual.push({ id: c.id, name: c.properties.name, domain: '', fit_score: c.properties.cleararmor_fit_score, reason: 'MANUAL: no domain on record' }); done++; continue; }
    const hit = await crawlCompany(browser, domain);
    if (hit) {
      found.push({
        company_id: c.id, company: c.properties.name, domain,
        fit_score: c.properties.cleararmor_fit_score, source_url: hit.url,
        name_guess: hit.nameGuess, role_guess: hit.roleGuess,
        snippet: hit.snippet.replace(/[\r\n]+/g, ' ').slice(0, 300)
      });
    } else {
      manual.push({ id: c.id, name: c.properties.name, domain, fit_score: c.properties.cleararmor_fit_score, reason: 'MANUAL: no diversity/SBLO page found' });
    }
    done++;
    if (done % 25 === 0) {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      console.log(done + '/' + gaps.length + ' crawled (' + mins + ' min elapsed) - ' + found.length + ' found, ' + manual.length + ' manual');
    }
    await new Promise(r => setTimeout(r, 300));
  }
  await browser.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const foundCsv = toCsv(found, ['company_id','company','domain','fit_score','source_url','name_guess','role_guess','snippet']);
  const manualCsv = toCsv(manual, ['id','name','domain','fit_score','reason']);
  const foundFile = 'sblo-found-' + stamp + '.csv';
  const manualFile = 'sblo-manual-' + stamp + '.csv';
  fs.writeFileSync(foundFile, foundCsv);
  fs.writeFileSync(manualFile, manualCsv);

  console.log('DONE. Gaps processed: ' + gaps.length + ' | FOUND (candidate doors): ' + found.length + ' | MANUAL: ' + manual.length);
  console.log('Local files: ' + path.resolve(foundFile) + ' and ' + path.resolve(manualFile));

  const patPath = process.env.TEMP + '\\pat.txt';
  let token;
  try { token = fs.readFileSync(patPath, 'utf8').trim(); } catch (e) { console.error('Could not read PAT at ' + patPath + ' - files saved locally only.'); return; }

  const r1 = await pushToGithub(token, foundFile, foundCsv);
  const r2 = await pushToGithub(token, manualFile, manualCsv);
  console.log('Push ' + foundFile + ': ' + r1.status + ' | Push ' + manualFile + ': ' + r2.status);
  console.log('READBACK NAMES FOR CLAUDE: ' + foundFile + ' , ' + manualFile);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });