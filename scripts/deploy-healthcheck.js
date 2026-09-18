/**
 * Deployment Script for NetSuite Health Check & Calendar Mode to Mango Server via FTP
 */

const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');

// Parse credentials from .env.local
const envPath = path.resolve(__dirname, '../.env.local');
const content = fs.readFileSync(envPath, 'utf-8');
const lines = content.split('\n');

let host = '';
let user = '';
let pass = '';
let port = 21;
let isFtp = false;

for (const line of lines) {
  const t = line.trim();
  if (t.includes('FTP realestate') || t.includes('Mango setup')) { isFtp = true; continue; }
  if (t.includes('Database raw price')) { isFtp = false; continue; }
  if (t.startsWith('ADDRESS_MYGREEN')) host = t.split('=')[1].replace(/["']/g, '').trim();
  if (isFtp && t && !t.startsWith('#')) {
    const parts = t.split('=');
    const k = parts[0].trim();
    const v = parts.slice(1).join('=').replace(/["']/g, '').trim();
    if (k === 'USER') user = v;
    if (k === 'PASS') pass = v;
    if (k === 'PORT') port = parseInt(v, 10);
  }
}

const localRoot = path.resolve(__dirname, '../../mango');
const localBackupDir = path.resolve(__dirname, '../../scratch/ftp_backup');
if (!fs.existsSync(localBackupDir)) {
  fs.mkdirSync(localBackupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

async function deploy() {
  console.log('====================================================');
  console.log('🚀 Deploying Health Check & Calendar to Mango FTP');
  console.log(`⏰ Timestamp: ${timestamp}`);
  console.log('====================================================\n');

  const client = new ftp.Client();
  try {
    await client.access({ host, user, password: pass, port, secure: false });
    console.log('✅ Connected to FTP Server successfully!');

    // 1. Upload healthcheck files & index.aspx to erp-aa/currency/fx/
    await client.cd('erp-aa/currency/fx');
    console.log(`📂 Changed directory to: erp-aa/currency/fx`);

    const fxRoot = path.resolve(localRoot, 'fx');
    const healthFiles = [
      'healthcheck.aspx',
      'healthcheck.aspx.cs'
    ];

    for (const file of healthFiles) {
      const srcPath = path.join(fxRoot, file);
      console.log(`  🚀 Uploading: ${file} (${fs.statSync(srcPath).size} bytes)`);
      await client.uploadFrom(srcPath, file);
    }

    // 2. Upload fx/index.aspx to erp-aa/currency/fx/
    const fxFile = 'index.aspx';
    const fxSrcPath = path.join(fxRoot, fxFile);

    // Download remote backup
    const fxBackupPath = path.join(localBackupDir, `fx-index.aspx.bak-${timestamp}`);
    try {
      await client.downloadTo(fxBackupPath, fxFile);
      console.log(`  💾 Downloaded remote copy to local backup: ${fxBackupPath}`);
    } catch (e) {
      console.log(`  ⚠️ Could not download live copy: ${e.message}`);
    }

    // Upload new version
    console.log(`  🚀 Uploading new version: ${fxFile} (${fs.statSync(fxSrcPath).size} bytes)`);
    await client.uploadFrom(fxSrcPath, fxFile);

    // Upload gas-trigger.gs.txt if exists
    const gasTextPath = path.join(fxRoot, 'gas-trigger.gs.txt');
    if (fs.existsSync(gasTextPath)) {
      console.log(`  🚀 Uploading: gas-trigger.gs.txt (${fs.statSync(gasTextPath).size} bytes)`);
      await client.uploadFrom(gasTextPath, 'gas-trigger.gs.txt');
    }

    console.log('\n====================================================');
    console.log('🌐 Verifying HTTP endpoints (Testing Compilation)...');
    console.log('====================================================');

    const urls = [
      'https://realestate.mygreentownhousing.com/erp-aa/currency/fx/healthcheck.aspx?sendmail=false',
      'https://realestate.mygreentownhousing.com/erp-aa/currency/fx/index.aspx?tab=calendar'
    ];

    for (const u of urls) {
      try {
        const start = Date.now();
        const res = await fetch(u);
        const elapsed = Date.now() - start;
        console.log(`\nURL: ${u}`);
        console.log(`Status: ${res.status} ${res.statusText} (${elapsed}ms)`);
        const text = await res.text();
        if (text.includes('Compiler Error') || text.includes('Compilation Error') || text.includes('Server Error in')) {
          console.error(`❌ Compilation/Server Error detected in ${u}!`);
          console.error(text.substring(0, 1000));
        } else {
          console.log(`✅ Compilation successful! Page length: ${text.length} chars`);
        }
      } catch (err) {
        console.error(`❌ Request failed: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('❌ Deployment failed:', err.message);
  } finally {
    client.close();
  }
}

deploy();
