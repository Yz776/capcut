// src/services/vod-uploader.js
//
// ByteDance VOD / ImageX upload client (pure HTTP, no SDK needed).
//
// REVERSE-ENGINEERED from CapCut's ttuploader__delayed.3deeb332.js chunk:
//   - Algorithm: AWS Sigv4 (AWS4-HMAC-SHA256), NOT Volcengine SignV4
//   - Headers: X-Amz-Date, x-amz-security-token, X-Amz-Content-Sha256
//   - Signing key: HMAC(`AWS4${secretAccessKey}`, date) → region → service → "aws4_request"
//   - Authorization: `AWS4-HMAC-SHA256 Credential=<akid>/<scope>, SignedHeaders=<hdrs>, Signature=<sig>`
//   - API Version: 2018-08-01 (NOT 2023-05-01)
//   - Service name: imagex (for images) or vod (for videos)
//
// STS token from CapCut's prepare_upload_cloud Mode A:
//   security_token.access_key_id   → AccessKeyId
//   security_token.secret_access_key → SecretAccessKey
//   security_token.session_token   → SessionToken
//
// ImageX ApplyImageUpload flow:
//   1. POST GET https://<upload_domain>/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=<svc>&UploadBytes=<size>
//      → Returns Result.UploadAddress: { StoreInfos: [{StoreUri, UploadID}], UploadHosts: [...], SessionKey, UploadHeader }
//   2. POST file bytes to https://<UploadHost>/<StoreUri>
//      Headers: Authorization: <UploadHeader.Authorization>, Content-Type
//   3. POST GET https://<upload_domain>/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=<svc>&SessionKey=<key>
//      → Returns Result.Results[0]: { Uri, MainUrl }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { logger } from '../utils/logger.js';

const VOLC_API_VERSION = '2018-08-01'; // From ttuploader.js
const VOLC_SERVICE_IMAGEX = 'imagex';
const VOLC_SERVICE_VOD = 'vod';
const VOLC_REGION_DEFAULT = 'i18n'; // From ttuploader.js default config (NOT 'ap-singapore-1')

// AWS Sigv4 helpers
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

// AWS Sigv4 URI encoding (RFC 3986, slash always encoded)
function awsUriEncode(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      ch === '-' || ch === '.' || ch === '_' || ch === '~'
    ) {
      out += ch;
    } else {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// Canonical query string per AWS Sigv4 (sort by key, encode both key and value, join with & and =)
function canonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map(k => `${awsUriEncode(k)}=${awsUriEncode(params[k])}`)
    .join('&');
}

// Headers not to sign (from sK in ttuploader.js)
const UNSIGNABLE_HEADERS = [
  'authorization', 'content-type', 'content-length', 'user-agent',
  'presigned-expires', 'expect', 'x-amzn-trace-id',
];

/**
 * Compute AWS Sigv4 signature.
 *
 * @param {Object} opts
 * @param {string} opts.method - HTTP method (GET, POST)
 * @param {string} opts.pathname - URL path (e.g., '/')
 * @param {Object} opts.query - query params (key→value)
 * @param {Object} opts.headers - request headers (will be merged with signing headers)
 * @param {string} opts.body - request body (for POST)
 * @param {string} opts.accessKeyId - STS access key id
 * @param {string} opts.secretAccessKey - STS secret access key
 * @param {string} opts.sessionToken - STS session token
 * @param {string} opts.region - e.g., 'ap-singapore-1'
 * @param {string} opts.service - 'imagex' or 'vod'
 * @returns {{headers: Object, signature: string, authorization: string, amzDate: string}}
 */
export function signAwsV4Request({
  method, pathname, query = {}, headers = {}, body = '',
  accessKeyId, secretAccessKey, sessionToken,
  region, service,
}) {
  const now = new Date();
  // X-Amz-Date format: YYYYMMDDTHHMMSSZ (no dashes/colons/millis)
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  // Build headers including AWS-required ones
  const allHeaders = { ...headers };
  allHeaders['X-Amz-Date'] = amzDate;
  if (sessionToken) {
    allHeaders['x-amz-security-token'] = sessionToken;
  }
  if (body) {
    allHeaders['X-Amz-Content-Sha256'] = sha256Hex(body);
  }

  // Canonical headers: lowercase keys, sorted, value trimmed of multiple whitespace
  const headerEntries = Object.entries(allHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')])
    .filter(([k]) => !UNSIGNABLE_HEADERS.includes(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');

  // Body hash (empty body = sha256 of empty string)
  const bodyHash = body
    ? (allHeaders['X-Amz-Content-Sha256'] || sha256Hex(body))
    : sha256Hex('');

  // Canonical request
  const cq = canonicalQueryString(query);
  const canonicalRequest = `${method.toUpperCase()}\n${pathname}\n${cq}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;

  // Credential scope: date/region/service/aws4_request
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // String to sign
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

  // Signing key chain (NOTE: "AWS4" prefix on secret!)
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');

  // Signature
  const signature = hmacSha256Hex(kSigning, stringToSign);

  // Authorization header
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: allHeaders,
    signature,
    authorization,
    amzDate,
    credentialScope,
  };
}

/**
 * ApplyImageUpload — Step 1 of ImageX upload flow.
 * Returns Result.UploadAddress: { StoreInfos, UploadHosts, SessionKey, UploadHeader }.
 *
 * @param {Object} sts - STS credentials from prepare_upload_cloud Mode A
 * @param {Object} opts - { serviceId, fileSize, fileName, region }
 * @returns {Promise<Object>} { StoreInfos, UploadHosts, SessionKey, UploadHeader, ... }
 */
export async function applyImageUpload(sts, { serviceId, fileSize, fileName, region = VOLC_REGION_DEFAULT }) {
  const host = sts.upload_domain;
  const pathname = '/';
  const query = {
    Action: 'ApplyImageUpload',
    Version: VOLC_API_VERSION,
    ServiceId: serviceId,
    UploadBytes: String(fileSize),
  };
  if (fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext) query.FileExtension = ext;
  }

  const signed = signAwsV4Request({
    method: 'GET',
    pathname,
    query,
    headers: { host },
    body: '',
    accessKeyId: sts.security_token.access_key_id,
    secretAccessKey: sts.security_token.secret_access_key,
    sessionToken: sts.security_token.session_token,
    region,
    service: VOLC_SERVICE_IMAGEX,
  });

  const url = `https://${host}${pathname}?${canonicalQueryString(query)}`;
  logger.info({ url: url.slice(0, 120), fileName, fileSize }, 'applyImageUpload: GET');

  const res = await axios.get(url, {
    headers: {
      Host: host,
      'X-Amz-Date': signed.amzDate,
      'x-amz-security-token': sts.security_token.session_token,
      Authorization: signed.authorization,
    },
    timeout: 30000,
  });

  logger.info({ status: res.status, respData: JSON.stringify(res.data).slice(0, 600) }, 'applyImageUpload: response');

  if (res.data?.ResponseMetadata?.Error) {
    throw new Error(`ApplyImageUpload failed: ${res.data.ResponseMetadata.Error.Code} - ${res.data.ResponseMetadata.Error.Message}`);
  }
  return res.data?.Result || res.data;
}

/**
 * Upload file bytes to the upload host returned by ApplyImageUpload.
 *
 * @param {Object} applyResult - Result from applyImageUpload
 * @param {Buffer} fileBuf - file bytes
 * @param {string} contentType - e.g., 'image/jpeg'
 * @returns {Promise<{status: number, storeUri: string, uploadId: string, sessionKey: string}>}
 */
export async function uploadImageBytes(applyResult, fileBuf, contentType = 'image/jpeg') {
  const uploadAddress = applyResult.UploadAddress || applyResult.uploadAddress;
  const uploadHost = (uploadAddress.UploadHosts || uploadAddress.uploadHosts)[0];
  const storeInfo = (uploadAddress.StoreInfos || uploadAddress.storeInfos)[0];
  const storeUri = storeInfo.StoreUri || storeInfo.storeUri;
  const uploadId = storeInfo.UploadID || storeInfo.uploadId;
  const sessionKey = uploadAddress.SessionKey || uploadAddress.sessionKey;
  const uploadHeader = uploadAddress.UploadHeader || uploadAddress.uploadHeader || {};

  if (!uploadHost || !storeUri) {
    throw new Error(`uploadImageBytes: missing UploadHost/StoreUri. Got: ${JSON.stringify(applyResult).slice(0, 400)}`);
  }

  const url = `https://${uploadHost}/${storeUri}`;
  logger.info({ url: url.slice(0, 80), size: fileBuf.length }, 'uploadImageBytes: POST');

  const res = await axios.post(url, fileBuf, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileBuf.length),
      Authorization: uploadHeader.Authorization || uploadHeader.authorization,
      ...(uploadHeader['X-Credential-SessionToken'] ? { 'X-Credential-SessionToken': uploadHeader['X-Credential-SessionToken'] } : {}),
    },
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  logger.info({ status: res.status }, 'uploadImageBytes: done');
  return { status: res.status, storeUri, uploadId, sessionKey, response: res.data };
}

/**
 * CommitImageUpload — Step 3 of ImageX upload flow.
 * Finalizes the upload and returns the final image URL (via image CDN).
 *
 * @param {Object} sts - STS credentials
 * @param {Object} opts - { serviceId, sessionKey, region }
 * @returns {Promise<Object>} { Results: [{Uri, MainUrl, BackupUrls}] }
 */
export async function commitImageUpload(sts, { serviceId, sessionKey, region = VOLC_REGION_DEFAULT }) {
  const host = sts.upload_domain;
  const pathname = '/';
  const query = {
    Action: 'CommitImageUpload',
    Version: VOLC_API_VERSION,
    ServiceId: serviceId,
    SessionKey: sessionKey,
  };

  const signed = signAwsV4Request({
    method: 'GET',
    pathname,
    query,
    headers: { host },
    body: '',
    accessKeyId: sts.security_token.access_key_id,
    secretAccessKey: sts.security_token.secret_access_key,
    sessionToken: sts.security_token.session_token,
    region,
    service: VOLC_SERVICE_IMAGEX,
  });

  const url = `https://${host}${pathname}?${canonicalQueryString(query)}`;
  logger.info({ url: url.slice(0, 120) }, 'commitImageUpload: GET');

  const res = await axios.get(url, {
    headers: {
      Host: host,
      'X-Amz-Date': signed.amzDate,
      'x-amz-security-token': sts.security_token.session_token,
      Authorization: signed.authorization,
    },
    timeout: 30000,
  });

  logger.info({ status: res.status, respData: JSON.stringify(res.data).slice(0, 600) }, 'commitImageUpload: response');

  if (res.data?.ResponseMetadata?.Error) {
    throw new Error(`CommitImageUpload failed: ${res.data.ResponseMetadata.Error.Code} - ${res.data.ResponseMetadata.Error.Message}`);
  }
  return res.data?.Result || res.data;
}

/**
 * Full ImageX upload flow: ApplyImageUpload → upload bytes → CommitImageUpload.
 *
 * @param {Object} sts - STS credentials from prepare_upload_cloud Mode A
 * @param {string} filePath - local file path
 * @returns {Promise<{storeUri: string, mainUrl: string, imageInfo: Object, sessionKey: string}>}
 */
export async function uploadImageViaImageX(sts, filePath) {
  const fileBuf = fs.readFileSync(filePath);
  const fileSize = fileBuf.length;
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

  logger.info({ fileSize, fileName }, 'uploadImageViaImageX: starting');

  // Step 1: ApplyImageUpload
  const applyResult = await applyImageUpload(sts, {
    serviceId: sts.service_id,
    fileSize,
    fileName,
  });

  // Step 2: Upload bytes
  const uploadRes = await uploadImageBytes(applyResult, fileBuf, contentType);

  // Step 3: CommitImageUpload
  const commitResult = await commitImageUpload(sts, {
    serviceId: sts.service_id,
    sessionKey: uploadRes.sessionKey,
  });

  // Result is an array of {Uri, MainUrl, BackupUrls: []}
  const imageInfo = Array.isArray(commitResult?.Results) ? commitResult.Results[0] : commitResult?.Results?.[0];
  return {
    storeUri: uploadRes.storeUri,
    mainUrl: imageInfo?.MainUrl || imageInfo?.mainUrl,
    imageInfo,
    sessionKey: uploadRes.sessionKey,
    applyResult,
    commitResult,
  };
}

// CRC32 table (IEEE 802.3 polynomial — same as ttuploader.js i3 table)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32buf(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * FULL VOD Upload Pipeline (VERIFIED WORKING).
 *
 * Uses /lv/v1/upload_sign (biz=replicate) to get STS token, then:
 *   1. ApplyUploadInner → get StoreUri, Auth, UploadHost, SessionKey
 *   2. POST file bytes to UploadHost/StoreUri with Content-CRC32: "ignore"
 *   3. CommitUploadInner (POST with body {SessionKey, Functions:[]})
 *
 * Returns Vid + VideoMeta.Uri (the asset identifiers for create_cloud_asset).
 *
 * @param {Object} api - CapCutDirectAPI instance (for /lv/v1/upload_sign call)
 * @param {string} filePath - local file path
 * @param {Object} opts - { biz: 'replicate'|'web_video' (default 'replicate'), userId }
 * @returns {Promise<{vid: string, uri: string, md5: string, fileSize: number, width: number, height: number, spaceName: string, sessionKey: string}>}
 */
export async function uploadFileVOD(api, filePath, { biz = 'replicate', userId = '' } = {}) {
  const fileBuf = fs.readFileSync(filePath);
  const fileSize = fileBuf.length;
  const fileName = path.basename(filePath);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const contentType = ext === 'png' ? 'image/png'
    : ext === 'mp4' ? 'video/mp4'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg';

  logger.info({ filePath, fileSize, fileName, biz }, 'uploadFileVOD: starting');

  // === Step 1: /lv/v1/upload_sign (retry on ret=1014) ===
  let signRes = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    signRes = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/upload_sign',
      { key_version: 'v5', biz }
    );
    if (signRes.data?.ret === '0') break;
    lastErr = `ret=${signRes.data?.ret} errmsg=${signRes.data?.errmsg}`;
    logger.warn({ attempt, lastErr, biz }, 'upload_sign failed, retrying');
    if (String(signRes.data?.ret) !== '1014') break;
    await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  if (signRes?.data?.ret !== '0') {
    throw new Error(`/lv/v1/upload_sign failed: ${lastErr}`);
  }
  const token = signRes.data.data;
  const spaceName = token.space_name;
  logger.info({ spaceName, biz }, 'uploadFileVOD: got STS token');

  // === Step 2: ApplyUploadInner ===
  const host = 'vod-ap-singapore-1.bytevcloudapi.com';
  const applyQuery = {
    Action: 'ApplyUploadInner',
    Version: '2020-11-19',
    SpaceName: spaceName,
    UploadBytes: String(fileSize),
  };
  const applySigned = signAwsV4Request({
    method: 'GET',
    pathname: '/',
    query: applyQuery,
    headers: { host },
    body: '',
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_access_key,
    sessionToken: token.session_token,
    region: 'i18n',
    service: 'vod',
  });
  const applyUrl = `https://${host}/?${canonicalQueryString(applyQuery)}`;
  const applyRes = await axios.get(applyUrl, {
    headers: {
      Host: host,
      'X-Amz-Date': applySigned.amzDate,
      'x-amz-security-token': token.session_token,
      Authorization: applySigned.authorization,
    },
    timeout: 30000,
  });
  if (applyRes.data?.ResponseMetadata?.Error) {
    throw new Error(`ApplyUploadInner failed: ${applyRes.data.ResponseMetadata.Error.Code} - ${applyRes.data.ResponseMetadata.Error.Message}`);
  }
  const applyResult = applyRes.data?.Result;
  const uploadNode = applyResult.InnerUploadAddress.UploadNodes[0];
  const storeInfo = uploadNode.StoreInfos[0];
  const uploadHost = uploadNode.UploadHost;
  const sessionKey = uploadNode.SessionKey;
  logger.info({ vid: uploadNode.Vid, storeUri: storeInfo.StoreUri, uploadHost }, 'uploadFileVOD: ApplyUploadInner done');

  // === Step 3: Upload file bytes ===
  const uploadUrl = `https://${uploadHost}/${storeInfo.StoreUri}`;
  const crc32 = crc32buf(fileBuf);
  const upRes = await axios.post(uploadUrl, fileBuf, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      Authorization: storeInfo.Auth,
      // CRITICAL: Content-CRC32 must be the LITERAL string "ignore"
      // (sending the actual CRC32 causes "MismatchChecksum" error)
      'Content-CRC32': 'ignore',
      'X-Storage-U': encodeURIComponent(userId),
    },
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (upRes.status >= 400) {
    throw new Error(`Upload failed: HTTP ${upRes.status} ${JSON.stringify(upRes.data).slice(0, 200)}`);
  }
  logger.info({ status: upRes.status, hash: upRes.data?.payload?.hash }, 'uploadFileVOD: bytes uploaded');

  // Wait briefly for upload to propagate to commit endpoint
  await new Promise(r => setTimeout(r, 3000));

  // === Step 4: CommitUploadInner (POST with body) ===
  const commitBody = JSON.stringify({ SessionKey: sessionKey, Functions: [] });
  const commitQuery = {
    Action: 'CommitUploadInner',
    Version: '2020-11-19',
    SpaceName: spaceName,
  };
  const commitSigned = signAwsV4Request({
    method: 'POST',
    pathname: '/',
    query: commitQuery,
    headers: { host, 'content-type': 'application/json' },
    body: commitBody,
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_access_key,
    sessionToken: token.session_token,
    region: 'i18n',
    service: 'vod',
  });
  const commitUrl = `https://${host}/?${canonicalQueryString(commitQuery)}`;
  const commitRes = await axios.post(commitUrl, commitBody, {
    headers: {
      Host: host,
      'Content-Type': 'application/json',
      'X-Amz-Date': commitSigned.amzDate,
      'X-Amz-Content-Sha256': commitSigned.headers['X-Amz-Content-Sha256'],
      'x-amz-security-token': token.session_token,
      Authorization: commitSigned.authorization,
    },
    timeout: 30000,
  });
  if (commitRes.data?.ResponseMetadata?.Error) {
    throw new Error(`CommitUploadInner failed: ${commitRes.data.ResponseMetadata.Error.Code} - ${commitRes.data.ResponseMetadata.Error.Message}`);
  }
  const commitResult = commitRes.data?.Result;
  const result0 = commitResult?.Results?.[0];
  if (!result0) {
    throw new Error(`CommitUploadInner returned no Results: ${JSON.stringify(commitResult).slice(0, 300)}`);
  }
  logger.info({ vid: result0.Vid, uri: result0.VideoMeta?.Uri }, 'uploadFileVOD: CommitUploadInner done');

  return {
    vid: result0.Vid,
    uri: result0.VideoMeta?.Uri || storeInfo.StoreUri,
    md5,
    crc32: crc32.toString(16),
    fileSize,
    width: result0.VideoMeta?.Width,
    height: result0.VideoMeta?.Height,
    spaceName,
    sessionKey,
    storeUri: storeInfo.StoreUri,
    raw: { applyResult, commitResult },
  };
}

export default {
  uploadImageViaImageX,
  uploadFileVOD,
  applyImageUpload,
  uploadImageBytes,
  commitImageUpload,
  signAwsV4Request,
  crc32buf,
};
