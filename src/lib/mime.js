// Outlook does not send plain HTML. It sends MIME with the html part encoded
// as quoted-printable (or occasionally base64), so `=` becomes `=3D`, `#`
// becomes `=23`, and long lines are broken with soft `=\r\n` wraps that can
// split a tag in half.
//
// Feeding that straight to an HTML parser is silently destructive: a style
// attribute reads `background:=23C6EFCE` instead of `background:#C6EFCE`, the
// green-PO test fails, tags broken across a soft wrap stop matching, and rows
// are either dropped entirely or written with null loading date, month and
// country. Decode first, always.

const CRLF = /\r?\n/;

function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function headerValue(head, name) {
  const m = head.match(
    new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im')
  );
  return m ? m[1].replace(CRLF, ' ').trim() : '';
}

function splitHeadBody(part) {
  const i = part.search(/\r?\n\r?\n/);
  if (i < 0) return [part, ''];
  const gap = part.slice(i).match(/^\r?\n\r?\n/)[0].length;
  return [part.slice(0, i), part.slice(i + gap)];
}

function decodeBody(head, body) {
  const enc = headerValue(head, 'Content-Transfer-Encoding').toLowerCase();
  if (enc.startsWith('base64')) return decodeBase64(body);
  if (enc.startsWith('quoted-printable')) return decodeQuotedPrintable(body);
  return body; // 7bit / 8bit / binary / absent
}

// Walks a MIME message, including a multipart/alternative nested inside a
// multipart/mixed, and returns the DECODED text/html part. Falls back to
// text/plain, then to the whole decoded body.
export function htmlPartOf(raw) {
  const [head, body] = splitHeadBody(raw);
  const ctype = headerValue(head, 'Content-Type');
  const boundary = (ctype.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];

  if (!boundary) {
    const decoded = decodeBody(head, body);
    return /text\/plain/i.test(ctype) && !/<t[dr][\s>]/i.test(decoded) ? '' : decoded;
  }

  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = body.split(new RegExp(`--${esc}(?:--)?\\r?\\n`)).filter(Boolean);
  let html = '';
  let plain = '';
  for (const part of parts) {
    if (!part || !part.trim()) continue;
    const [ph, pb] = splitHeadBody(part);
    const pct = headerValue(ph, 'Content-Type');
    if (/multipart\//i.test(pct)) {
      const nested = htmlPartOf(part);
      if (nested) html = html || nested;
    } else if (/text\/html/i.test(pct)) {
      html = html || decodeBody(ph, pb);
    } else if (/text\/plain/i.test(pct)) {
      plain = plain || decodeBody(ph, pb);
    }
  }
  return html || plain;
}

export const _internals = { decodeQuotedPrintable, decodeBase64, headerValue };

// Attachments, by filename and decoded bytes.
//
// Ray was asked to attach the MLS as an .xlsx as well as pasting it, because
// the attachment keeps the cell colours and colour is data in that file. The
// Worker does not yet parse the workbook - rowsFromWorkbook() exists and takes
// the xlsx library by injection, but no library is bundled - so the honest
// behaviour is to SEE the attachment and say so. An attachment that arrives and
// is silently ignored is the same failure that discarded eighteen ships'
// schedules: the file was there, nothing read it, and nothing said anything.
export function attachmentsOf(raw) {
  const [head, body] = splitHeadBody(raw);
  const ctype = headerValue(head, 'Content-Type');
  const boundary = (ctype.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
  if (!boundary) return [];

  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = body.split(new RegExp(`--${esc}(?:--)?\\r?\\n`)).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!part || !part.trim()) continue;
    const [ph, pb] = splitHeadBody(part);
    const pct = headerValue(ph, 'Content-Type');
    if (/multipart\//i.test(pct)) { out.push(...attachmentsOf(part)); continue; }

    const disp = headerValue(ph, 'Content-Disposition');
    const name =
      (disp.match(/filename\s*=\s*"?([^";\r\n]+)"?/i) || [])[1] ||
      (pct.match(/name\s*=\s*"?([^";\r\n]+)"?/i) || [])[1] || '';
    // An inline text/html part is the message, not an attachment.
    const isAttachment = /attachment/i.test(disp) || (name && !/^text\/(html|plain)/i.test(pct));
    if (!isAttachment || !name) continue;

    out.push({
      filename: name.trim(),
      contentType: pct.split(';')[0].trim(),
      // Bytes are decoded but not parsed. Whoever wires the workbook path gets
      // a buffer, not another decoding problem.
      content: decodeBody(ph, pb),
    });
  }
  return out;
}
