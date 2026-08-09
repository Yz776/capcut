// scripts/test-direct-api.js
//
// End-to-end test for CapCut direct API client.
// Verifies each endpoint step-by-step:
//   1. getAccountInfo (validate session)
//   2. getWorkspaces
//   3. multiGetTemplates
//   4. getTemplateFile
//   5. saveDraft (create from template)
//   6. uploadAsset (for each test image)
//   7. patchDraftMaterials
//   8. saveDraft (update with patched content)
//   9. createRenderTask
//  10. pollRenderTask
//  11. downloadVideo

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';
const TEST_IMAGES = [
  path.join(projectRoot, 'test-assets', 'img1.jpg'),
  path.join(projectRoot, 'test-assets', 'img2.jpg'),
].filter(p => fs.existsSync(p));

const OUT_DIR = path.join(projectRoot, 'tmp', 'direct-api-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

function log(step, msg, data) {
  console.log(`\n[step ${step}] ${msg}`);
  if (data !== undefined) {
    const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(s.length > 2000 ? s.slice(0, 2000) + '\n...[TRUNCATED]' : s);
  }
}

function saveArtifact(name, data) {
  const fpath = path.join(OUT_DIR, name);
  const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(fpath, s);
  console.log(`  saved: ${fpath} (${s.length} bytes)`);
}

async function main() {
  const api = new CapCutDirectAPI();

  // === STEP 1: Validate session ===
  log(1, 'getAccountInfo — validating session');
  let accountInfo;
  try {
    accountInfo = await api.getAccountInfo();
    log(1, '✓ session valid', accountInfo);
    saveArtifact('01-account.json', accountInfo);
  } catch (e) {
    log(1, '✗ session invalid', e.message);
    console.error('Run npm run login:manual to refresh session.');
    process.exit(1);
  }

  // === STEP 2: Get workspaces ===
  log(2, 'getWorkspaces');
  let workspaces;
  try {
    workspaces = await api.getWorkspaces();
    log(2, '✓ workspaces', workspaces);
    saveArtifact('02-workspaces.json', workspaces);
  } catch (e) {
    log(2, '✗ failed (continuing)', e.message);
    saveArtifact('02-error.txt', e.message + '\n' + (e.stack || ''));
  }

  // === STEP 3: Multi-get templates ===
  log(3, `multiGetTemplates — template ${TEMPLATE_ID}`);
  let templateMeta;
  try {
    templateMeta = await api.multiGetTemplates(TEMPLATE_ID);
    log(3, '✓ template meta', templateMeta);
    saveArtifact('03-template-meta.json', templateMeta);
  } catch (e) {
    log(3, '✗ failed (continuing)', e.message);
    saveArtifact('03-error.txt', e.message + '\n' + (e.stack || ''));
  }

  // === STEP 4: Get template file (draft content) ===
  log(4, `getTemplateFile — fetching draft content`);
  let templateFile;
  try {
    templateFile = await api.getTemplateFile(TEMPLATE_ID);
    log(4, '✓ template file fetched', {
      hasContent: !!templateFile,
      keys: Object.keys(templateFile || {}).slice(0, 10),
    });
    saveArtifact('04-template-file.json', templateFile);
  } catch (e) {
    log(4, '✗ getTemplateFile failed', e.message);
    saveArtifact('04-error.txt', e.message + '\n' + (e.stack || ''));
    // Try alternative endpoint
    try {
      log(4, 'trying getTemplateDetail...');
      const detail = await api.getTemplateDetail(TEMPLATE_ID);
      log(4, '✓ getTemplateDetail succeeded', detail);
      saveArtifact('04-template-detail.json', detail);
      templateFile = detail;
    } catch (e2) {
      log(4, '✗ getTemplateDetail also failed', e2.message);
    }
  }

  // === STEP 5: Save draft from template ===
  log(5, 'saveDraft — creating user draft from template');
  let draftId;
  try {
    const draftContent = templateFile?.content || templateFile || {
      template_id: TEMPLATE_ID,
      source: 'template',
    };
    const saveRes = await api.saveDraft(draftContent, {
      videoName: `Test ${TEMPLATE_ID}`,
    });
    draftId = saveRes.draft_id || saveRes.id;
    log(5, '✓ draft created', { draftId, saveRes });
    saveArtifact('05-save-draft.json', saveRes);
  } catch (e) {
    log(5, '✗ saveDraft failed', e.message);
    saveArtifact('05-error.txt', e.message + '\n' + (e.stack || ''));
    // Continue anyway — we can still test other endpoints
  }

  // === STEP 6: Upload test assets ===
  log(6, `uploadAsset — uploading ${TEST_IMAGES.length} test images`);
  const uploadedAssets = [];
  for (let i = 0; i < TEST_IMAGES.length; i++) {
    const imgPath = TEST_IMAGES[i];
    try {
      log(6, `  uploading ${path.basename(imgPath)}...`);
      const asset = await api.uploadAsset(imgPath);
      uploadedAssets.push(asset);
      log(6, `  ✓ uploaded`, asset);
    } catch (e) {
      log(6, `  ✗ upload failed: ${e.message}`);
      saveArtifact(`06-upload-error-${i}.txt`, e.message + '\n' + (e.stack || ''));
    }
  }
  saveArtifact('06-uploaded-assets.json', uploadedAssets);

  if (uploadedAssets.length === 0) {
    log(6, '⚠ no assets uploaded, cannot patch draft materials');
  }

  // === STEP 7: Patch draft materials ===
  log(7, 'patchDraftMaterials — swapping template materials → user assets');
  let patchedContent;
  if (templateFile && uploadedAssets.length > 0) {
    try {
      const content = templateFile.content || templateFile;
      patchedContent = api.patchDraftMaterials(content, uploadedAssets);
      log(7, '✓ draft patched', {
        originalImages: content?.materials?.images?.length || 0,
        patchedImages: patchedContent?.materials?.images?.length || 0,
      });
      saveArtifact('07-patched-draft.json', patchedContent);
    } catch (e) {
      log(7, '✗ patch failed', e.message);
    }
  } else {
    log(7, '⚠ skipped (need both templateFile and uploaded assets)');
  }

  // === STEP 8: Save patched draft ===
  log(8, 'saveDraft — persisting patched draft');
  if (patchedContent && draftId) {
    try {
      const saveRes = await api.saveDraft(patchedContent, { draftId, videoName: `Test ${TEMPLATE_ID}` });
      log(8, '✓ draft updated', saveRes);
      saveArtifact('08-save-patched.json', saveRes);
    } catch (e) {
      log(8, '✗ failed', e.message);
    }
  } else {
    log(8, '⚠ skipped');
  }

  // === STEP 9: Create render task ===
  log(9, 'createRenderTask — submitting render');
  let taskId;
  if (draftId) {
    try {
      const renderRes = await api.createRenderTask({
        draftId,
        videoName: `Render ${TEMPLATE_ID} ${Date.now()}`,
        definition: '720p', // lower res for faster test
      });
      taskId = renderRes.task_id;
      log(9, '✓ render task created', renderRes);
      saveArtifact('09-create-render.json', renderRes);
    } catch (e) {
      log(9, '✗ failed', e.message);
      saveArtifact('09-error.txt', e.message + '\n' + (e.stack || ''));
    }
  } else {
    log(9, '⚠ skipped (no draftId)');
  }

  // === STEP 10: Poll render task ===
  log(10, 'pollRenderTask — waiting for render');
  let videoUrl;
  if (taskId) {
    try {
      const pollRes = await api.pollRenderTask(taskId, {
        intervalMs: 5000,
        timeoutMs: 300000,
        onProgress: ({ status, progress }) => {
          log(10, `  status=${status} progress=${progress}%`);
        },
      });
      videoUrl = pollRes.video_url;
      log(10, '✓ render done', pollRes);
      saveArtifact('10-poll-result.json', pollRes);
    } catch (e) {
      log(10, '✗ poll failed', e.message);
      saveArtifact('10-error.txt', e.message + '\n' + (e.stack || ''));
    }
  } else {
    log(10, '⚠ skipped (no taskId)');
  }

  // === STEP 11: Download video ===
  log(11, 'downloadVideo — fetching MP4');
  if (videoUrl) {
    try {
      const outPath = path.join(OUT_DIR, `render-${TEMPLATE_ID}-${Date.now()}.mp4`);
      const dlRes = await api.downloadVideo(videoUrl, outPath);
      log(11, '✓ video downloaded', dlRes);
    } catch (e) {
      log(11, '✗ download failed', e.message);
    }
  } else {
    log(11, '⚠ skipped (no videoUrl)');
  }

  log('done', `\nAll artifacts saved to ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
