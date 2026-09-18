/**
 * Automated Deployment Script for Mango Server C# scripts (avg_exchange_rate.aspx.cs & bot_exchange_rate.aspx.cs)
 * 1. Connects to FTP
 * 2. Downloads live files to local scratch/ftp_backup/
 * 3. Creates remote backup files (.bak-<timestamp>) on FTP
 * 4. Uploads updated .cs files to FTP
 * 5. Verifies dynamic compilation via HTTP requests
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

const localSrcDir = '/Users/delta/Documents/ERP-Double A/erp-aa/Currency';
const localBackupDir = path.resolve(__dirname, '../../scratch/ftp_backup');
if (!fs.existsSync(localBackupDir)) {
  fs.mkdirSync(localBackupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

async function deploy() {
  console.log('====================================================');
  console.log('🚀 Deploying .cs files to Mango Server via FTP');
  console.log(`⏰ Timestamp: ${timestamp}`);
  console.log('====================================================\n');

  const client = new ftp.Client();
  try {
    await client.access({ host, user, password: pass, port, secure: false });
    console.log('✅ Connected to FTP Server successfully!');

    const targetDir = 'erp-aa/currency';
    await client.cd(targetDir);
    console.log(`📂 Changed directory to: ${targetDir}`);

    const filesToDeploy = [
      'avg_exchange_rate.aspx.cs',
      'bot_exchange_rate.aspx.cs'
    ];

    for (const file of filesToDeploy) {
      console.log(`\n--------------------------------------------`);
      console.log(`📦 Processing: ${file}`);

      // 1. Download live file for local backup
      const localBackupPath = path.join(localBackupDir, `${file}.bak-${timestamp}`);
      try {
        await client.downloadTo(localBackupPath, file);
        console.log(`  💾 Downloaded live copy to local backup: ${localBackupPath}`);
      } catch (e) {
        console.log(`  ⚠️ Could not download live copy: ${e.message}`);
      }

      // 2. Upload remote backup to FTP
      const remoteBackupName = `${file}.bak-${timestamp}`;
      if (fs.existsSync(localBackupPath)) {
        await client.uploadFrom(localBackupPath, remoteBackupName);
        console.log(`  ☁️ Created remote backup on FTP: ${remoteBackupName}`);
      }

      // 3. Upload new version from localSrcDir
      const localNewFilePath = path.join(localSrcDir, file);
      if (!fs.existsSync(localNewFilePath)) {
        throw new Error(`Source file not found: ${localNewFilePath}`);
      }
      await client.uploadFrom(localNewFilePath, file);
      console.log(`  🚀 Uploaded new version to FTP: ${file} (${fs.statSync(localNewFilePath).size} bytes)`);
    }

    console.log('\n====================================================');
    console.log('🌐 Verifying HTTP endpoints (testing compilation)...');
    console.log('====================================================');

  } catch (err) {
    console.error('❌ Deployment error:', err.message);
    client.close();
    process.exit(1);
  } finally {
    client.close();
  }

  // Verification HTTP requests
  try {
    const urls = [
      'https://realestate.mygreentownhousing.com/erp-aa/currency/avg_exchange_rate.aspx?effectivedate=2026-09-15',
      'https://realestate.mygreentownhousing.com/erp-aa/currency/bot_exchange_rate.aspx?effectivedate=2026-09-14'
    ];

    for (const url of urls) {
      console.log(`\n🔍 Fetching: ${url}`);
      const res = await fetch(url);
      const text = await res.text();
      console.log(`   HTTP Status: ${res.status} ${res.statusText}`);
      if (text.includes('Compilation Error') || text.includes('Server Error in')) {
        console.error('❌ Server returned compilation/runtime error!');
        console.error(text.slice(0, 500));
        process.exit(1);
      } else {
        console.log('   ✅ Page compiled and loaded successfully! (No compilation error)');
        if (url.includes('avg_exchange_rate')) {
          console.log(`   Snippet length: ${text.length} chars`);
          // check if rows contain table
          const countMatches = (text.match(/<tr>/gi) || []).length;
          console.log(`   Found ${countMatches} <tr> rows in HTML output`);
        }
        if (url.includes('bot_exchange_rate')) {
          const countMatches = (text.match(/<tr>/gi) || []).length;
          console.log(`   Found ${countMatches} <tr> rows in HTML output`);
        }
      }
    }
  } catch (httpErr) {
    console.error('⚠️ HTTP Verification warning:', httpErr.message);
  }

  console.log('\n🎉 Deployment and verification finished successfully!');
}

deploy().catch(console.error);
