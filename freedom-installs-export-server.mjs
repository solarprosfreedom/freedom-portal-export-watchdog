import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.INSTALLS_RELAY_PORT || 8774);
const workspace = process.cwd();
const allProjectsMode = process.env.FREEDOM_EXPORT_MODE === "all-projects";
const outputDir = join(workspace, "outputs", allProjectsMode ? "freedom_all_projects" : "freedom_installs");
const statePath = join(outputDir, "state.json");
const candidatesPath = join(outputDir, allProjectsMode ? "project-candidates.json" : "install-candidates.json");
const resultsPath = join(outputDir, allProjectsMode ? "project-results.json" : "install-results.json");
const samplePath = join(outputDir, "project-search-sample.json");
const csvPath = join(outputDir, allProjectsMode ? "FreedomPortal_All_Projects.csv" : "FreedomPortal_Installs.csv");
const tokenPath = join(outputDir, ".relay-token");
const portalOrigin = "https://portal.freedomforever.com";
const defaultPageSize = Number(process.env.INSTALLS_PAGE_SIZE || 250);
const detailBatchSize = Number(process.env.INSTALLS_DETAIL_BATCH || 3);
let writes = Promise.resolve();
const detailLeases = new Map();

await mkdir(outputDir, { recursive: true });

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readOrCreateToken() {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (/^[a-f0-9]{48}$/i.test(existing)) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const generated = randomBytes(24).toString("hex");
  await writeFile(tokenPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

const token = await readOrCreateToken();

function clean(value) { return String(value ?? "").trim(); }
function csvCell(value) {
  const text = clean(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function defaultState() {
  return {
    version: 2,
    nextPage: 0,
    pageSize: defaultPageSize,
    pages: null,
    totalResults: null,
    enumerationComplete: false,
    listRowsScanned: 0,
    installCandidates: 0,
    detailsSaved: 0,
    detailsUnavailable: 0,
    detailsRetry: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function currentState(state) {
  return Number(state?.version) === 2 ? state : defaultState();
}

function headers(origin) {
  return {
    "Access-Control-Allow-Origin": origin === portalOrigin ? portalOrigin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Freedom-Installs-Token",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
  };
}

function send(response, status, body, origin, contentType = "application/json") {
  response.writeHead(status, { ...headers(origin), "Content-Type": contentType });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_500_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validId(value) { return /^\d+$/.test(clean(value)); }
function validCandidate(record) {
  return record && validId(record.id) && (allProjectsMode || clean(record.stage) === "Final Completed") &&
    ["projectName", "financePartner", "installDate", "address", "stage"].every((key) => record[key] === undefined || typeof record[key] === "string");
}
function validDetail(record) {
  return record && validId(record.id) && ["saved", "unavailable", "retry-later"].includes(record.status) &&
    ["customerName", "phone", "email", "address", "financePartner", "installDate", "reason"].every((key) => record[key] === undefined || typeof record[key] === "string");
}

async function rebuildCsv(candidates, results) {
  const header = [
    "Project ID", "Customer Name", "Customer Phone", "Customer Email",
    "Customer Address", "Finance Partner", "Install Date",
    ...(allProjectsMode ? ["Stage"] : []),
    "Project URL",
  ];
  const ids = Object.keys(results).filter((id) => candidates[id]).sort((a, b) => Number(b) - Number(a));
  const rows = ids.map((id) => {
    const candidate = candidates[id] || {};
    const result = results[id] || {};
    return [
      id,
      result.customerName || candidate.projectName,
      result.phone,
      result.email,
      result.address || candidate.address,
      result.financePartner || candidate.financePartner,
      result.installDate || candidate.installDate,
      ...(allProjectsMode ? [candidate.stage] : []),
      `${portalOrigin}/projects/${id}`,
    ].map(csvCell).join(",");
  });
  const temporary = `${csvPath}.tmp`;
  await writeFile(temporary, `${[header.join(","), ...rows].join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, csvPath);
}

async function status() {
  const [storedState, candidates, results] = await Promise.all([
    readJson(statePath, defaultState()),
    readJson(candidatesPath, {}),
    readJson(resultsPath, {}),
  ]);
  const state = currentState(storedState);
  const finalCount = Object.values(results).filter((record) => ["saved", "partial", "unavailable"].includes(record?.status)).length;
  return {
    ...state,
    installCandidates: Object.keys(candidates).length,
    detailsFinal: finalCount,
    detailsRemaining: Math.max(0, Object.keys(candidates).length - finalCount),
    csvRows: Object.keys(results).length,
    csvPath,
  };
}

async function storePage(payload) {
  writes = writes.catch(() => undefined).then(async () => {
    const expectedFilterStage = allProjectsMode ? "" : "Final Completed";
    if (clean(payload.filterStage) !== expectedFilterStage) {
      throw new Error(allProjectsMode ? "All-project enumeration must not use a stage filter" : "Install enumeration must use the Final Completed stage filter");
    }
    const [storedState, storedCandidates, results] = await Promise.all([
      readJson(statePath, defaultState()),
      readJson(candidatesPath, {}),
      readJson(resultsPath, {}),
    ]);
    const state = currentState(storedState);
    const candidates = Number(storedState?.version) === 2 ? storedCandidates : {};
    const page = Number(payload.page);
    if (!Number.isInteger(page) || page < 0) throw new Error("Invalid page");
    if (page < state.nextPage) return status();
    if (page !== state.nextPage) throw new Error(`Expected page ${state.nextPage}, received ${page}`);
    const incoming = Array.isArray(payload.candidates) ? payload.candidates : [];
    for (const record of incoming) {
      if (!validCandidate(record)) continue;
      const id = clean(record.id);
      candidates[id] = {
        projectName: clean(record.projectName),
        financePartner: clean(record.financePartner),
        installDate: clean(record.installDate),
        address: clean(record.address),
        stage: clean(record.stage),
        discoveredAt: candidates[id]?.discoveredAt || new Date().toISOString(),
      };
    }
    state.pageSize = Number(payload.pageSize) || state.pageSize || defaultPageSize;
    state.pages = Number(payload.pages) || state.pages;
    state.totalResults = Number(payload.totalResults) || state.totalResults;
    state.listRowsScanned += Math.max(0, Number(payload.rowsCount) || 0);
    state.nextPage = page + 1;
    state.enumerationComplete = Boolean(payload.complete) || Number(payload.rowsCount) < state.pageSize;
    state.installCandidates = Object.keys(candidates).length;
    state.updatedAt = new Date().toISOString();
    await Promise.all([writeJsonAtomic(statePath, state), writeJsonAtomic(candidatesPath, candidates)]);
    if (payload.sample) {
      const previousSample = await readJson(samplePath, null);
      if (!previousSample || !Array.isArray(previousSample.rows) || previousSample.rows.length === 0) {
        await writeJsonAtomic(samplePath, payload.sample);
      }
    }
    await rebuildCsv(candidates, results);
    return status();
  });
  return writes;
}

function clearExpiredLeases() {
  const now = Date.now();
  for (const [id, expiresAt] of detailLeases) if (expiresAt <= now) detailLeases.delete(id);
}

async function nextDetails(limit = detailBatchSize) {
  const [candidates, results] = await Promise.all([readJson(candidatesPath, {}), readJson(resultsPath, {})]);
  clearExpiredLeases();
  const ids = [];
  // Newer Portal projects reliably expose address-summary; older IDs often throw
  // a browser-side TypeError. Work newest-first so useful rows fill immediately.
  for (const id of Object.keys(candidates).sort((left, right) => Number(right) - Number(left))) {
    if (["saved", "partial", "unavailable"].includes(results[id]?.status)) continue;
    if (detailLeases.has(id)) continue;
    detailLeases.set(id, Date.now() + 10 * 60 * 1000);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids.map((id) => ({ id, ...candidates[id], existing: results[id] || null }));
}

async function storeDetails(records) {
  writes = writes.catch(() => undefined).then(async () => {
    const [state, candidates, results] = await Promise.all([
      readJson(statePath, defaultState()),
      readJson(candidatesPath, {}),
      readJson(resultsPath, {}),
    ]);
    for (const record of records) {
      if (!validDetail(record) || !candidates[clean(record.id)]) continue;
      const id = clean(record.id);
      const previous = results[id] || {};
      const retryCount = record.status === "retry-later" ? Number(previous.retryCount || 0) + 1 : 0;
      const exhausted = record.status === "retry-later" && retryCount >= 2;
      results[id] = {
        status: exhausted ? "partial" : record.status,
        customerName: clean(record.customerName) || candidates[id].projectName,
        phone: clean(record.phone),
        email: clean(record.email),
        address: clean(record.address) || candidates[id].address,
        financePartner: clean(record.financePartner) || candidates[id].financePartner,
        installDate: clean(record.installDate) || candidates[id].installDate,
        ...(record.reason ? { reason: clean(record.reason) } : {}),
        ...(record.status === "retry-later" ? { retryCount } : {}),
        retrievedAt: new Date().toISOString(),
      };
      detailLeases.delete(id);
    }
    state.detailsSaved = Object.values(results).filter((record) => record.status === "saved").length;
    state.detailsPartial = Object.values(results).filter((record) => record.status === "partial").length;
    state.detailsUnavailable = Object.values(results).filter((record) => record.status === "unavailable").length;
    state.detailsRetry = Object.values(results).filter((record) => record.status === "retry-later").length;
    state.updatedAt = new Date().toISOString();
    await Promise.all([writeJsonAtomic(statePath, state), writeJsonAtomic(resultsPath, results)]);
    if (!allProjectsMode || state.detailsSaved % 250 < records.length || state.detailsSaved + state.detailsUnavailable >= Object.keys(candidates).length) {
      await rebuildCsv(candidates, results);
    }
    return status();
  });
  return writes;
}

function runnerSource() {
  return `
const relay = ${JSON.stringify(`http://${host}:${port}`)};
const relayToken = ${JSON.stringify(token)};
const allProjectsMode = ${JSON.stringify(allProjectsMode)};
const supervisorKey = ${JSON.stringify(allProjectsMode ? "__freedomAllProjectsSupervisor" : "__freedomInstallsSupervisor")};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestHeaders = { 'Content-Type': 'application/json', 'X-Freedom-Installs-Token': relayToken };

if (globalThis[supervisorKey]?.running) {
  console.info('Freedom ' + (allProjectsMode ? 'all-projects' : 'installs') + ' supervisor is already running.');
} else {
  const supervisor = { version: ${allProjectsMode ? 9 : 8}, running: true, complete: false, phase: 'starting', pages: 0, listRows: 0, candidates: 0, details: 0, errors: 0, startedAt: Date.now(), lastProgressAt: Date.now() };
  globalThis[supervisorKey] = supervisor;

  const firstText = value => String(value ?? '').trim();
  const flat = (value, prefix = '', out = {}) => {
    if (value == null) return out;
    if (Array.isArray(value)) { value.forEach((child, index) => flat(child, prefix ? prefix + '.' + index : String(index), out)); return out; }
    if (typeof value === 'object') { Object.entries(value).forEach(([key, child]) => flat(child, prefix ? prefix + '.' + key : key, out)); return out; }
    out[prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = firstText(value);
    return out;
  };
  const pick = (entries, tests) => {
    for (const test of tests) {
      for (const [key, value] of entries) if (value && (typeof test === 'string' ? key === test : test.test(key))) return value;
    }
    return '';
  };
  const validInstallDate = value => {
    const text = firstText(value);
    return text && !/^(?:n\\/?a|null|none|undefined|-|—)$/i.test(text) && (/[a-z]{3,9}\\s+\\d{1,2}/i.test(text) || /\\d{1,4}[\\/-]\\d{1,2}[\\/-]\\d{1,4}/.test(text) || /\\d{4}-\\d{2}-\\d{2}/.test(text));
  };
  const candidateFrom = row => {
    const values = flat(row); const entries = Object.entries(values);
    const stage = firstText(row?.stage?.label || row?.stage?.name || (typeof row?.stage === 'string' ? row.stage : '')) || pick(entries, ['stage_label', 'stage_name', /(?:^|_)stage_(?:label|name)$/, /^stage$/]);
    if (!allProjectsMode && stage.toLowerCase() !== 'final completed') return null;
    const installTask = Array.isArray(row?.process_task_projects)
      ? row.process_task_projects.find(task =>
          (Number(task?.process_task_id) === 45 || task?.process_task_identifier === 'complete_installation') &&
          (task?.status_identifier === 'complete' || task?.status?.identifier === 'complete') &&
          validInstallDate(task?.completed_at)
        )
      : null;
    let id = firstText(row?.id) || pick(entries, ['project_id', /(?:^|_)project_id$/, /^id$/]);
    let projectName = firstText(row?.name) || pick(entries, ['project_name', /(?:^|_)project_name$/, /homeowner_name$/, /customer_name$/]);
    let financePartner = firstText(row?.primary_finance_company_name) || pick(entries, [/primary_finance_company_name$/, /finance_company_name$/, /finance_partner$/, /financing$/]);
    let installDate = firstText(installTask?.completed_at) || pick(entries, ['task_45_completed_at', /process_task_projects_\d+_completed_at$/, /(?:^|_)task_45_completed_at$/, /complete_installation_install_complete_date$/, /install_complete_date$/, /installation_complete_date$/]);
    let address = firstText(row?.installation_address) || pick(entries, ['install_address', /install_address$/, /installation_address$/, /customer_address$/]);
    if (Array.isArray(row)) {
      id ||= firstText(row[0]); projectName ||= firstText(row[1]); financePartner ||= firstText(row[2]); installDate ||= firstText(row[3]); address ||= firstText(row[4]);
    }
    if (!/^\\d+$/.test(id)) return null;
    return { id, projectName, financePartner, installDate, address, stage };
  };
  const objectNodes = root => {
    const nodes = []; const seen = new WeakSet(); const stack = [root];
    while (stack.length) { const value = stack.pop(); if (!value || typeof value !== 'object' || seen.has(value)) continue; seen.add(value); nodes.push(value); Object.values(value).forEach(child => { if (child && typeof child === 'object') stack.push(child); }); }
    return nodes;
  };
  const field = (nodes, names) => {
    for (const node of nodes) for (const name of names) if (typeof node?.[name] === 'string' && node[name].trim()) return node[name].trim();
    return '';
  };
  const addressFrom = nodes => {
    for (const node of nodes) {
      const formatted = field([node], ['full_address', 'formatted_address', 'customer_address', 'installation_address', 'address']);
      if (formatted) return formatted;
      const street = field([node], ['street_address', 'street', 'address_1', 'address1', 'line1']);
      const city = field([node], ['city']); const state = field([node], ['state', 'state_code']); const zip = field([node], ['zip_code', 'zipcode', 'zip', 'postal_code']);
      if (street || city || state || zip) return [street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');
    }
    return '';
  };
  const contactFrom = (data, candidate) => {
    const nodes = [data?.lead, ...objectNodes(data)].filter(Boolean);
    const first = field(nodes, ['first_name', 'firstName']); const last = field(nodes, ['last_name', 'lastName']);
    const customerName = field(nodes, ['homeowner_name', 'customer_name', 'full_name', 'name']) || [first, last].filter(Boolean).join(' ') || candidate.projectName;
    const phone = field(nodes, ['homeowner_phone', 'phone', 'phone_number', 'mobile_phone']);
    const email = field(nodes, ['homeowner_email', 'email', 'email_address']);
    const financePartner = field(nodes, ['primary_finance_company', 'finance_company', 'finance_partner', 'financing']) || candidate.financePartner;
    return { customerName, phone, email, address: addressFrom(nodes) || candidate.address, financePartner, installDate: candidate.installDate };
  };
  async function local(path, options = {}) {
    const response = await fetch(relay + path, { mode: 'cors', ...options, headers: { ...requestHeaders, ...(options.headers || {}) } });
    if (!response.ok) throw new Error('Local relay ' + response.status + ' for ' + path);
    return response.json();
  }
  async function searchPage(page, pageSize) {
    const payload = {
      page,
      pageSize,
      _token: typeof csrfToken === 'string' ? csrfToken : '',
      filters: allProjectsMode ? [] : [[{ filterId: 'stage', filterInput: 'Final Completed' }]],
      columnConfig: ['project_id', 'project_name', 'stage', 'primary_finance_company', 'task:45:completed_at', 'installation_address'],
      sorting: allProjectsMode
        ? [{ field: 'project_id', sort: 'desc', type: 'number' }]
        : [{ field: 'task:45:completed_at', sort: 'desc', type: 'date' }],
    };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch('/projects/search', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) throw new Error('Portal search returned ' + response.status);
      const text = await response.text();
      const parsed = JSON.parse(text);
      const data = parsed?.data;
      const rows = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.rows) ? data.rows
        : Array.isArray(data?.contracts) ? data.contracts
        : data && typeof data === 'object' ? Object.values(data).filter(value => value && typeof value === 'object')
        : Array.isArray(parsed) ? parsed : [];
      return { parsed, rows };
    } finally { clearTimeout(timer); }
  }
  const visibleText = element => element && element.getClientRects().length ? firstText(element.textContent) : '';
  const waitFor = async (check, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(500);
    }
    return null;
  };
  const labeledValue = (text, label) => {
    const lines = String(text || '').split(/\\r?\\n/).map(firstText).filter(Boolean);
    const wanted = label.toLowerCase();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]; const position = line.toLowerCase().indexOf(wanted);
      if (position < 0) continue;
      const values = [line.slice(position + label.length).replace(/^[:\\-–\\s]+/, ''), ...lines.slice(index + 1, index + 5)];
      for (const value of values) {
        if (!value || /^(homeowner|customer)\\s+(name|phone|email|preferred|address)/i.test(value)) continue;
        return value;
      }
    }
    return '';
  };
  const detailsTab = doc => [...doc.querySelectorAll('button, [role="tab"], [role="button"], a, .mat-tab-label')]
    .find(element => visibleText(element).replace(/\\s+/g, ' ').toLowerCase() === 'project details');
  async function inspectCandidate(candidate) {
    const existing = candidate.existing || {};
    let apiDetails = {};
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch('/projects/' + encodeURIComponent(candidate.id) + '/address-summary', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        apiDetails = contactFrom(await response.json(), candidate);
        const apiComplete = Boolean(
          apiDetails.customerName && apiDetails.phone && apiDetails.email &&
          apiDetails.address && apiDetails.financePartner
        );
        if (apiComplete) return { id: candidate.id, status: 'saved', ...apiDetails };
      }
    } catch {}
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;border:0';
    document.body.append(frame);
    try {
      frame.src = '/projects/' + encodeURIComponent(candidate.id);
      let opened = false;
      const ready = await waitFor(() => {
        const doc = frame.contentDocument; const text = doc?.body?.innerText || '';
        if (!doc || !text) return null;
        if (/\\bOops\\b|project not found|page not found/i.test(text)) return 'unavailable';
        const acknowledgement = [...doc.querySelectorAll('button')].find(button => /i understand/i.test(visibleText(button)));
        if (acknowledgement) { acknowledgement.click(); return null; }
        if (!opened) {
          const tab = detailsTab(doc);
          if (tab) { tab.click(); opened = true; return null; }
        }
        return /Customer Information|Homeowner (Phone|Email|Name)/i.test(text) ? doc : null;
      }, ${allProjectsMode ? 20000 : 30000});
      if (ready === 'unavailable') {
        return { id: candidate.id, status: 'unavailable', ...contactFrom({}, candidate), reason: 'portal-not-found' };
      }
      if (!ready) {
        return { id: candidate.id, status: 'retry-later', ...contactFrom({}, candidate), reason: 'project-details-timeout' };
      }
      const text = ready.body?.innerText || '';
      const customerName = labeledValue(text, 'Homeowner Name') || apiDetails.customerName || firstText(existing.customerName) || candidate.projectName;
      const phone = labeledValue(text, 'Homeowner Phone') || apiDetails.phone || firstText(existing.phone);
      const email = labeledValue(text, 'Homeowner Email') || apiDetails.email || firstText(existing.email);
      const address = labeledValue(text, 'Customer Address') || labeledValue(text, 'Installation Address') || apiDetails.address || firstText(existing.address) || candidate.address;
      const financePartner = apiDetails.financePartner || firstText(existing.financePartner) || candidate.financePartner;
      const complete = allProjectsMode || Boolean(customerName && phone && email && address && financePartner);
      return {
        id: candidate.id,
        status: complete ? 'saved' : 'retry-later',
        customerName, phone, email, address, financePartner,
        installDate: firstText(existing.installDate) || candidate.installDate,
        ...(complete ? {} : { reason: 'Project Details is missing one or more requested fields' }),
      };
    } catch (error) {
      return { id: candidate.id, status: 'retry-later', ...contactFrom({}, candidate), reason: String(error?.message || error?.name || error).slice(0, 180) };
    } finally {
      frame.remove();
    }
  }
  async function fillNextDetails() {
    const batch = await local('/next-details?limit=${detailBatchSize}');
    if (!batch.length) return null;
    const records = await Promise.all(batch.map(inspectCandidate));
    const current = await local('/details', { method: 'POST', body: JSON.stringify({ records }) });
    supervisor.details = current.detailsFinal;
    supervisor.lastProgressAt = Date.now();
    console.info('Install details: ' + current.detailsFinal + '/' + current.installCandidates + ' finalized; ' + current.detailsRemaining + ' remaining.');
    return current;
  }
  async function drainDetailsBeforeNextPage() {
    while (supervisor.running) {
      const current = await fillNextDetails();
      if (current?.detailsRemaining === 0) return current;
      if (!current) {
        const status = await local('/status');
        if (status.detailsRemaining === 0) return status;
        await sleep(1000);
      } else {
        await sleep(250);
      }
    }
    return null;
  }

  console.info('Freedom ' + (allProjectsMode ? 'all-projects' : 'installs') + ' export started.');
  while (supervisor.running) {
    try {
      let current = await local('/status');
      if (!current.enumerationComplete) {
        supervisor.phase = 'project-list';
        const { parsed, rows } = await searchPage(current.nextPage, current.pageSize);
        const candidates = rows.map(candidateFrom).filter(Boolean);
        const numberFrom = value => {
          if (typeof value === 'number') return value;
          const digits = String(value ?? '').replace(/[^0-9.-]/g, '');
          return digits ? Number(digits) : null;
        };
        const pageCount = numberFrom(parsed?.pages?.last_page ?? parsed?.pages?.total_pages ?? parsed?.pages);
        const totalResults = numberFrom(parsed?.totalResults ?? parsed?.total_results ?? parsed?.total);
        const pagePayload = {
          page: current.nextPage, pageSize: current.pageSize, rowsCount: rows.length,
          filterStage: allProjectsMode ? '' : 'Final Completed',
          pages: pageCount, totalResults,
          complete: rows.length < current.pageSize || (pageCount && current.nextPage >= pageCount),
          candidates,
          ...(current.nextPage === 1 ? { sample: {
            topLevelKeys: Object.keys(parsed || {}),
            dataType: Array.isArray(parsed?.data) ? 'array' : typeof parsed?.data,
            dataKeys: parsed?.data && typeof parsed.data === 'object' ? Object.keys(parsed.data).slice(0, 30) : [],
            pages: parsed?.pages,
            totalResults: parsed?.totalResults,
            rows: rows.slice(0, 2),
          } } : {}),
        };
        current = await local('/page', { method: 'POST', body: JSON.stringify(pagePayload) });
        supervisor.pages += 1; supervisor.listRows = current.listRowsScanned; supervisor.candidates = current.installCandidates;
        supervisor.lastProgressAt = Date.now();
        console.info((allProjectsMode ? 'All projects' : 'Installs') + ' list: page ' + (current.nextPage - 1) + '/' + (current.pages || '?') + ', ' + current.listRowsScanned + ' projects scanned, ' + current.installCandidates + ' candidates found.');
        supervisor.phase = 'project-list-and-customer-details';
        if (allProjectsMode) await drainDetailsBeforeNextPage();
        else await fillNextDetails();
        await sleep(350);
        continue;
      }

      supervisor.phase = 'customer-details';
      current = await fillNextDetails();
      if (!current) {
        current = await local('/status');
        if (current.detailsRemaining === 0) { supervisor.running = false; supervisor.complete = true; supervisor.phase = 'complete'; supervisor.lastProgressAt = Date.now(); console.info('Freedom ' + (allProjectsMode ? 'all-projects' : 'installs') + ' export complete: ' + current.csvRows + ' CSV rows.'); break; }
        console.info('No immediately available install-detail records; waiting before retry.');
        await sleep(10000); continue;
      }
      await sleep(500);
    } catch (error) {
      supervisor.errors += 1;
      console.warn('Freedom installs supervisor recovered from:', error?.message || error);
      await sleep(Math.min(30000, 2000 * supervisor.errors));
    }
  }
}
`;
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") { send(response, 204, "", origin, "text/plain"); return; }
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (url.pathname === (allProjectsMode ? "/all-projects-supervisor.mjs" : "/installs-supervisor.mjs") && request.method === "GET") {
      send(response, 200, runnerSource(), origin, "text/javascript; charset=utf-8"); return;
    }
    if (url.pathname === "/status" && request.method === "GET") {
      send(response, 200, JSON.stringify(await status()), origin); return;
    }
    if (request.headers["x-freedom-installs-token"] !== token) { send(response, 403, JSON.stringify({ error: "Forbidden" }), origin); return; }
    if (url.pathname === "/page" && request.method === "POST") {
      const result = await storePage(JSON.parse(await requestBody(request))); send(response, 200, JSON.stringify(result), origin); return;
    }
    if (url.pathname === "/next-details" && request.method === "GET") {
      const limit = Math.max(1, Math.min(32, Number(url.searchParams.get("limit")) || detailBatchSize));
      send(response, 200, JSON.stringify(await nextDetails(limit)), origin); return;
    }
    if (url.pathname === "/details" && request.method === "POST") {
      const payload = JSON.parse(await requestBody(request));
      const result = await storeDetails(Array.isArray(payload.records) ? payload.records : []); send(response, 200, JSON.stringify(result), origin); return;
    }
    send(response, 404, JSON.stringify({ error: "Not found" }), origin);
  } catch (error) {
    send(response, 500, JSON.stringify({ error: error?.message || String(error) }), origin);
  }
});

server.listen(port, host, () => {
  console.log(`Freedom ${allProjectsMode ? "all-projects" : "installs"} relay listening on http://${host}:${port}`);
  console.log(`CSV will be written to ${csvPath}`);
});
