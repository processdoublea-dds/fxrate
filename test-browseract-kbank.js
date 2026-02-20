const https = require('https');

const API_KEY = "app-4ZxbOmrB9OgcyWSXXmNH8esx";
const WORKFLOW_ID = "80827033896840284";

async function runTask() {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ workflow_id: WORKFLOW_ID });
        const options = {
            hostname: 'api.browseract.com',
            port: 443,
            path: '/v2/workflow/run-task',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const response = JSON.parse(body);
                if (res.statusCode === 200) {
                    resolve(response.id);
                } else {
                    reject(response);
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getTask(taskId) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.browseract.com',
            port: 443,
            path: `/v2/workflow/get-task?task_id=${taskId}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(body));
                else reject(JSON.parse(body));
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    try {
        console.log("Starting KBANK workflow on BrowserAct...");
        const taskId = await runTask();
        console.log(`Task created successfully. Task ID: ${taskId}`);
        console.log("Polling for completion...");

        let status = 'started';
        let result = null;
        while (status !== 'finished' && status !== 'failed' && status !== 'canceled') {
            await sleep(3000);
            result = await getTask(taskId);
            status = result.status;
            process.stdout.write(`Status: ${status}... `);
        }
        console.log("\nDone!");

        if (status === 'finished') {
            console.log("----- RAW OUTPUT -----");
            console.log(result.output.string);
        } else {
            console.log("Task did not finish successfully:", result);
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

main();
