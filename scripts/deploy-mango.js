/**
 * Automated Deployment Script for Mango Server FX Inspector
 * Uploads mango/fx/index.aspx to Server Mango via FTP
 * 
 * Usage:
 *   npm run deploy:mango
 */

const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');

// Helper to parse .env.local file safely without exposing default passwords
function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    let isFtpSection = false;
    let isDbSection = false;
    const config = {
        ftpHost: process.env.FTP_HOST || process.env.ADDRESS_MYGREEN || '',
        ftpUser: process.env.FTP_USER || '',
        ftpPass: process.env.FTP_PASS || '',
        ftpPort: process.env.FTP_PORT ? parseInt(process.env.FTP_PORT, 10) : 21,
    };

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) {
            if (line.includes('## Mango setup') || line.includes('FTP realestate')) {
                isFtpSection = true;
                isDbSection = false;
            } else if (line.includes('Database raw price')) {
                isFtpSection = false;
                isDbSection = true;
            }
            continue;
        }

        const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*["']?([^"']+)["']?$/);
        if (match) {
            const key = match[1].trim();
            const val = match[2].trim();

            if (key === 'ADDRESS_MYGREEN' || key === 'FTP_HOST') {
                config.ftpHost = val;
            } else if (isFtpSection && key === 'USER') {
                config.ftpUser = val;
            } else if (isFtpSection && key === 'PASS') {
                config.ftpPass = val;
            } else if (key === 'FTP_USER') {
                config.ftpUser = val;
            } else if (key === 'FTP_PASS') {
                config.ftpPass = val;
            } else if (key === 'FTP_PORT') {
                config.ftpPort = parseInt(val, 10);
            }
        }
    }
    return config;
}

async function deploy() {
    console.log('🚀 Starting deployment to Mango Server via FTP...\n');

    const envPath = path.resolve(__dirname, '../.env.local');
    const config = parseEnvFile(envPath);

    if (!config.ftpHost || !config.ftpUser || !config.ftpPass) {
        console.error('❌ Error: Missing FTP credentials in .env.local (ADDRESS_MYGREEN, USER, PASS)');
        process.exit(1);
    }

    console.log(`📍 Target Host : ${config.ftpHost}`);
    console.log(`👤 FTP User    : ${config.ftpUser}`);

    // Look for source file in root mango/ directory
    let localFilePath = path.resolve(__dirname, '../../mango/fx/index.aspx');
    if (!fs.existsSync(localFilePath)) {
        localFilePath = path.resolve(__dirname, '../mango/fx/index.aspx');
    }

    if (!fs.existsSync(localFilePath)) {
        console.error(`❌ Source file not found at: ${localFilePath}`);
        process.exit(1);
    }

    console.log(`📁 Source File : ${localFilePath}`);

    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
        await client.access({
            host: config.ftpHost,
            user: config.ftpUser,
            password: config.ftpPass,
            port: config.ftpPort || 21,
            secure: false,
        });

        console.log('\n✅ Connected to FTP Server successfully!');

        const list = await client.list();
        let targetDir = 'currency/fx';
        const hasErpAa = list.some(item => item.name.toLowerCase() === 'erp-aa');
        const hasCurrency = list.some(item => item.name.toLowerCase() === 'currency');

        if (hasErpAa) {
            targetDir = 'erp-aa/currency/fx';
        } else if (hasCurrency) {
            targetDir = 'currency/fx';
        } else {
            targetDir = 'fx';
        }

        console.log(`📂 Ensuring remote directory: ${targetDir}`);
        await client.ensureDir(targetDir);

        console.log(`📤 Uploading index.aspx to ${targetDir}/index.aspx...`);
        await client.uploadFrom(localFilePath, 'index.aspx');

        console.log('\n🎉 Deployment completed successfully!');
        console.log(`🔗 Web URL: https://realestate.mygreentownhousing.com/erp-aa/currency/fx/index.aspx\n`);
    } catch (err) {
        console.error('\n❌ FTP Deployment failed:', err.message);
        process.exit(1);
    } finally {
        client.close();
    }
}

deploy();
