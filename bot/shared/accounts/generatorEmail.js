import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import { wakePage } from '../browser/pageHelpers.js';

let cachedDomains = null;

export function generateUsername(length = 12) {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

export function getEmailDomains() {
  if (!cachedDomains?.length) {
    throw new Error('Dominios nao carregados. Chame initEmailDomains(page) antes de criar emails.');
  }
  return cachedDomains;
}

export function pickRandomDomain() {
  const domains = getEmailDomains();
  return domains[randomInt(domains.length)];
}

export function createEmailAddress(username = generateUsername(), domain = pickRandomDomain()) {
  const allowed = getEmailDomains();
  if (!allowed.includes(domain)) {
    throw new Error(`Dominio nao permitido: ${domain}`);
  }
  return `${username}@${domain}`;
}

export async function initEmailDomains(page = null) {
  if (config.email.mode === 'fixed' || config.email.mode === 'env') {
    cachedDomains = config.email.domains;
    return cachedDomains;
  }

  try {
    cachedDomains = await fetchAvailableDomainsHttp();
  } catch (error) {
    if (!page) throw error;
    console.warn(`Dominios HTTP falhou (${error.message}) - fallback Puppeteer`);
    cachedDomains = await fetchAvailableDomains(page);
  }

  if (cachedDomains.length === 0) {
    throw new Error('Nenhum dominio encontrado no generator.email');
  }

  return cachedDomains;
}

export function parseEmailAddress(email) {
  const [username, domain] = email.split('@');
  if (!username || !domain) {
    throw new Error(`Email invalido: ${email}`);
  }
  return { username, domain };
}

export async function openInbox(page, email) {
  const { username, domain } = parseEmailAddress(email);

  await wakePage(page);
  await page.setCookie({
    name: 'surl',
    value: `${domain}/${username}`,
    domain: 'generator.email',
    path: '/',
  });

  await page.goto(`${config.email.baseUrl}/${domain}/${username}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await waitForPageStable(page);

  return email;
}

async function waitForPageStable(page, timeout = 8000) {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
  } catch {
    // ja estavel
  }
  await sleep(120);
}

async function safePageRead(page, readFn) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await readFn();
    } catch (error) {
      const retryable = /context was destroyed|detached|navigation|Execution context/i.test(error.message ?? '');
      if (!retryable || attempt === 3) throw error;
      await waitForPageStable(page, 5000);
    }
  }

  throw new Error('Falha ao ler pagina do inbox');
}

async function readInboxSnapshot(page) {
  return safePageRead(page, () =>
    page.evaluate(() => ({
      title: document.title?.trim() ?? '',
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 8000) ?? '',
    })),
  );
}

export function extractXaiVerificationCode(text) {
  if (!text) return null;

  const patterns = [
    /\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i,
    /confirmation code[:\s]+([A-Z0-9-]{6,10})/i,
    /c[oó]digo[:\s]+([A-Z0-9-]{6,10})/i,
    /\b([A-Z0-9]{6})\b/,
    /\b(\d{6})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const code = match?.[1] ?? match?.[0];
    if (code) return code.toUpperCase();
  }

  return null;
}

export function extractXaiVerifyLink(text) {
  if (!text) return null;

  const hrefMatches = text.match(/href=["'](https:\/\/accounts\.x\.ai[^"']+)["']/gi) ?? [];
  for (const raw of hrefMatches) {
    const link = raw.replace(/^href=["']/i, '').replace(/["']$/i, '').replace(/[.,;]+$/, '');
    if (isValidXaiVerifyLink(link)) return link;
  }

  const matches = text.match(/https:\/\/accounts\.x\.ai[^\s"'<>]+/gi) ?? [];

  for (const raw of matches) {
    const link = raw.replace(/[.,;]+$/, '');
    if (isValidXaiVerifyLink(link)) return link;
  }

  for (const raw of matches) {
    const link = raw.replace(/[.,;]+$/, '');
    if (/logo|static|asset|favicon|\.png|privacy|terms/i.test(link)) continue;
    if (link.includes('?')) return link;
  }

  return null;
}

export function isValidXaiVerifyLink(link) {
  if (!link || !/^https:\/\/accounts\.x\.ai\//i.test(link)) return false;
  if (/logo|static|asset|favicon|\.png|\.svg|\.jpg|privacy|terms/i.test(link)) return false;
  if (/[?&](token|code|otp|session|id|confirmation)=/i.test(link)) return true;
  return /verify|confirm|token|code|otp|session|magic|email-confirmation|callback/i.test(link);
}

export async function getInboxMessages(page) {
  return page.evaluate(() => {
    const messages = [];
    const seen = new Set();

    const addMessage = (entry) => {
      const key = `${entry.subject}|${entry.href ?? ''}`;
      if (!entry.subject || seen.has(key)) return;
      seen.add(key);
      messages.push(entry);
    };

    const title = document.title?.trim();
    if (title && /xai|confirmation|confirm|verify/i.test(title)) {
      addMessage({ href: location.href, subject: title, sender: 'page-title', fromTitle: true });
    }

    const rows = [...document.querySelectorAll('table tbody tr, #email-table tbody tr')];
    let rowIndex = 0;
    rows.forEach((row) => {
      const cells = [...row.querySelectorAll('td')];
      if (cells.length < 2) return;

      const sender = cells[0]?.textContent?.trim() ?? '';
      const subject = cells[1]?.textContent?.trim() ?? cells[cells.length - 2]?.textContent?.trim() ?? '';
      const link = row.querySelector('a[href]');
      let href = link?.href ?? link?.getAttribute('href') ?? null;

      if (href && !href.startsWith('http')) {
        href = `https://generator.email${href.startsWith('/') ? '' : '/'}${href}`;
      }

      if (subject.length > 2) {
        addMessage({ href, subject, sender, rowIndex });
        rowIndex += 1;
      }
    });

    const links = [...document.querySelectorAll('a[href*="inbox"], a[href*="mail"], a[href*="message"]')];
    for (const anchor of links) {
      const subject = anchor.textContent?.trim();
      if (subject && subject.length > 3) {
        addMessage({ href: anchor.href, subject, sender: '' });
      }
    }

    return messages;
  });
}

export async function refreshInbox(page) {
  await wakePage(page);

  const refreshBtn = await page.$('#refresh, a#refresh, button[onclick*="refresh"]');
  if (refreshBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
      refreshBtn.click(),
    ]);
    await waitForPageStable(page, 3000);
    return;
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await waitForPageStable(page);
}

export async function readMessage(page) {
  return safePageRead(page, () =>
    page.evaluate(() => {
      const body =
        document.querySelector('#email-content, .message-content, .messagembody, .msg-body, .mail-content') ??
        document.querySelector('.inbox-area, #message, .e-mail-content');

      return {
        html: body?.innerHTML ?? document.body.innerHTML,
        text: body?.textContent?.trim() ?? document.body.innerText.trim(),
        title: document.title?.trim() ?? '',
      };
    }),
  );
}

async function openInboxMessage(page, message) {
  if (message.fromTitle) return;

  if (message.rowIndex != null) {
    await safePageRead(page, () =>
      page.evaluate((index) => {
        const rows = [...document.querySelectorAll('table tbody tr, #email-table tbody tr')].filter(
          (row) => row.querySelectorAll('td').length >= 2,
        );
        const row = rows[index];
        const link = row?.querySelector('a') ?? row;
        link?.click();
      }, message.rowIndex),
    );
    await waitForPageStable(page);
    return;
  }

  if (message.href && message.href !== page.url()) {
    await page.goto(message.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForPageStable(page);
  }
}

export async function waitForEmail(page, options = {}) {
  const {
    timeout = 120_000,
    interval = 2500,
    subjectIncludes = null,
    onPoll = null,
  } = options;

  const deadline = Date.now() + timeout;
  const opened = new Set();
  let pollCount = 0;

  while (Date.now() < deadline) {
    try {
      await wakePage(page);

      const snapshot = await readInboxSnapshot(page);
      let snapshotResult = tryBuildResultFromText({
        subject: snapshot.title,
        title: snapshot.title,
        text: snapshot.bodyText,
        html: '',
        href: snapshot.url,
      }, subjectIncludes);

      if (snapshotResult && !snapshotResult.verifyLink) {
        const content = await readMessage(page);
        snapshotResult = buildEmailResult({
          message: { subject: snapshot.title, href: snapshot.url },
          content,
          fallbackCode: snapshotResult.code,
        });
      }

      if (snapshotResult) {
        if (onPoll) onPoll(snapshotResult);
        return snapshotResult;
      }

      const messages = await safePageRead(page, () => getInboxMessages(page));

      for (const message of messages) {
        if (subjectIncludes && !message.subject.toLowerCase().includes(subjectIncludes.toLowerCase())) {
          continue;
        }

        const key = message.href ?? message.subject;
        if (opened.has(key)) continue;
        opened.add(key);

        await openInboxMessage(page, message);
        const content = await readMessage(page);
        const result = buildEmailResult({ message, content });

        if (onPoll) onPoll(result);

        if (result.code || result.verifyLink) {
          return result;
        }

        if (/xai|confirmation|confirm/i.test(content.text) && content.text.length > 30) {
          return result;
        }
      }

      pollCount += 1;
      if (pollCount % 2 === 0) {
        await refreshInbox(page);
      }
    } catch (error) {
      if (/session closed|target closed/i.test(error.message)) {
        throw error;
      }
      console.warn('Poll inbox:', error.message);
      await waitForPageStable(page, 5000);
    }

    await sleep(interval);
  }

  throw new Error(`Timeout: nenhum email recebido em ${timeout / 1000}s`);
}

function tryBuildResultFromText(content, subjectIncludes) {
  const haystack = [content.subject, content.title, content.text].filter(Boolean).join('\n');
  if (subjectIncludes && !haystack.toLowerCase().includes(subjectIncludes.toLowerCase())) {
    return null;
  }

  if (!/xai|confirmation|confirm|verify/i.test(haystack)) {
    return null;
  }

  const code = extractXaiVerificationCode(content.subject)
    ?? extractXaiVerificationCode(content.title)
    ?? extractXaiVerificationCode(content.text);
  const verifyLink = extractXaiVerifyLink(haystack);

  if (!code && !verifyLink) return null;

  return buildEmailResult({
    message: { subject: content.subject ?? content.title, href: content.href },
    content,
    fallbackCode: code,
  });
}

export function extractPattern(text, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const match = text.match(regex);
  return match?.[1] ?? match?.[0] ?? null;
}

const GENERATOR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseDomainsFromHtml(html) {
  const domains = new Set();

  for (const match of html.matchAll(/<p[^>]+id="([a-z0-9][a-z0-9.-]+\.[a-z]{2,})"/gi)) {
    domains.add(match[1]);
  }

  for (const match of html.matchAll(/class="tt-suggestion[^"]*"[\s\S]*?<p[^>]*>([^<]+\.[a-z]{2,})<\/p>/gi)) {
    domains.add(match[1].trim());
  }

  for (const match of html.matchAll(/data-domain="([^"]+\.[a-z]{2,})"/gi)) {
    domains.add(match[1]);
  }

  return [...domains];
}

export async function fetchAvailableDomainsHttp() {
  const response = await fetch(config.email.baseUrl, {
    headers: { 'User-Agent': GENERATOR_UA },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`generator.email HTTP ${response.status}`);
  }

  const domains = parseDomainsFromHtml(await response.text());
  if (domains.length === 0) {
    throw new Error('Nenhum dominio encontrado no HTML do generator.email');
  }

  return domains;
}

export async function fetchAvailableDomains(page) {
  await page.goto(config.email.baseUrl, { waitUntil: 'domcontentloaded' });

  // Abre o dropdown de dominios do generator.email
  await page.click('#domainName2').catch(() => {});
  await page.evaluate(() => {
    const dropdown = document.getElementById('newselect');
    if (dropdown) dropdown.classList.remove('hide_all');
  });
  await sleep(150);

  const domains = await page.evaluate(() => {
    const fromDropdown = [...document.querySelectorAll('#newselect .tt-suggestion p[id]')]
      .map((el) => el.id || el.textContent?.trim())
      .filter((d) => d && d.includes('.'));

    if (fromDropdown.length > 0) return [...new Set(fromDropdown)];

    const fromSuggestions = [...document.querySelectorAll('.tt-suggestion p')]
      .map((el) => el.textContent?.trim())
      .filter((d) => d && d.includes('.'));

    return [...new Set(fromSuggestions)];
  });

  return domains;
}

function buildEmailResult({ message, content, fallbackCode = null }) {
  const combined = [content.html, content.text, content.title, message.subject].filter(Boolean).join('\n');
  const code =
    extractXaiVerificationCode(content.text)
    ?? extractXaiVerificationCode(content.title)
    ?? extractXaiVerificationCode(message.subject)
    ?? fallbackCode;
  const verifyLink = extractXaiVerifyLink(combined);

  return {
    ...message,
    ...content,
    code,
    verifyLink,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchInboxHtml(email) {
  return fetchGeneratorEmailPage(buildInboxUrl(email), email);
}

function buildInboxUrl(email) {
  const { username, domain } = parseEmailAddress(email);
  return `${config.email.baseUrl}/${domain}/${username}`;
}

async function fetchGeneratorEmailPage(url, email) {
  const { username, domain } = parseEmailAddress(email);

  const response = await fetch(url, {
    headers: {
      Cookie: `surl=${domain}/${username}`,
      'User-Agent': GENERATOR_UA,
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`generator.email HTTP ${response.status}`);
  }

  return response.text();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmailBodyFromHtml(html) {
  const bodyPatterns = [
    /id=["']email-content["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"']*messagembody[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"']*message-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"']*mail-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of bodyPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].length > 40) {
      return { html: match[1], text: stripHtml(match[1]) };
    }
  }

  return { html, text: stripHtml(html) };
}

function normalizeGeneratorHref(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  const base = config.email.baseUrl.replace(/\/$/, '');
  return `${base}${href.startsWith('/') ? '' : '/'}${href}`;
}

function findInboxMessageHrefs(html, email) {
  const hrefs = new Set();
  const { username, domain } = parseEmailAddress(email);
  const prefix = `/${domain}/${username}`;

  for (const row of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const chunk = row[0];
    if (!/xai|confirmation|confirm|verify/i.test(chunk)) continue;
    const href = chunk.match(/href=["']([^"']+)["']/i)?.[1];
    const normalized = normalizeGeneratorHref(href);
    if (normalized) hrefs.add(normalized);
  }

  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = match[1];
    if (!href.includes(prefix) && !/inbox|mail|message/i.test(href)) continue;
    if (/xai|confirmation|confirm|verify/i.test(href) || /\/[a-f0-9-]{8,}/i.test(href)) {
      const normalized = normalizeGeneratorHref(href);
      if (normalized) hrefs.add(normalized);
    }
  }

  return [...hrefs];
}

async function enrichEmailResultFromHtml(result, html, email, subjectIncludes) {
  if (result.verifyLink) return result;

  const body = extractEmailBodyFromHtml(html);
  const enriched = buildEmailResult({
    message: { subject: result.subject, href: result.href },
    content: { ...body, title: result.title ?? '' },
    fallbackCode: result.code,
  });

  if (enriched.verifyLink || enriched.code) {
    return enriched;
  }

  const hrefs = findInboxMessageHrefs(html, email);
  for (const href of hrefs) {
    try {
      const msgHtml = await fetchGeneratorEmailPage(href, email);
      const msgBody = extractEmailBodyFromHtml(msgHtml);
      const fromMessage = tryBuildResultFromText(
        {
          subject: result.subject,
          title: msgHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '',
          text: msgBody.text,
          html: msgBody.html,
          href,
        },
        subjectIncludes,
      );
      if (fromMessage?.verifyLink || fromMessage?.code) {
        return fromMessage;
      }
    } catch {
      // tenta proximo link
    }
  }

  return enriched.verifyLink || enriched.code ? enriched : result;
}

function parseInboxHtml(html, subjectIncludes) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const subjects = new Set([title]);
  for (const match of html.match(/[A-Z0-9]{3}-[A-Z0-9]{3}[^<]{0,40}xAI[^<]*/gi) ?? []) {
    subjects.add(match.trim());
  }

  for (const subject of subjects) {
    const result = tryBuildResultFromText(
      { subject, title, text: plainText, html, href: null },
      subjectIncludes,
    );
    if (result?.code || result?.verifyLink) {
      return result;
    }
  }

  return null;
}

export async function waitForEmailHttp(email, options = {}) {
  const {
    timeout = 120_000,
    interval = config.performance.emailPollMs,
    subjectIncludes = null,
    onPoll = null,
    onKeepAlive = null,
  } = options;

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (onKeepAlive) {
      await onKeepAlive().catch(() => {});
    }

    try {
      const html = await fetchInboxHtml(email);
      let result = parseInboxHtml(html, subjectIncludes);

      if (result) {
        result = await enrichEmailResultFromHtml(result, html, email, subjectIncludes);
        if (onPoll) onPoll(result);
        return result;
      }
    } catch (error) {
      console.warn('Poll inbox HTTP:', error.message);
    }

    await sleep(interval);
  }

  throw new Error(`Timeout: nenhum email recebido em ${timeout / 1000}s`);
}
