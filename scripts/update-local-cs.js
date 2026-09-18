const fs = require('fs');
const path = require('path');

// 1. Update avg_exchange_rate.aspx.cs
const avgPaths = [
  '/Users/delta/Documents/ERP-Double A/erp-aa/Currency/avg_exchange_rate.aspx.cs',
  path.resolve(__dirname, '../scratch/avg_exchange_rate.aspx.cs')
];

for (const p of avgPaths) {
  if (!fs.existsSync(p)) continue;
  let content = fs.readFileSync(p, 'utf-8');
  
  // Replace WHERE BankDate = @timestamp_bank
  // with WHERE cast(updated_date as date) = cast(@timestamp_bank as date)
  const targetPattern = /where\s+BankDate\s*=\s*@timestamp_bank/i;
  if (targetPattern.test(content)) {
    content = content.replace(targetPattern, 'where cast(updated_date as date) = cast(@timestamp_bank as date)');
    fs.writeFileSync(p, content, 'utf-8');
    console.log(`✅ Updated avg_exchange_rate.aspx.cs at: ${p}`);
  } else {
    console.log(`⚠️ Target pattern not found in ${p}`);
  }
}

// 2. Update bot_exchange_rate.aspx.cs
const botPaths = [
  '/Users/delta/Documents/ERP-Double A/erp-aa/Currency/bot_exchange_rate.aspx.cs',
  path.resolve(__dirname, '../scratch/bot_exchange_rate.aspx.cs')
];

for (const p of botPaths) {
  if (!fs.existsSync(p)) continue;
  let content = fs.readFileSync(p, 'utf-8');
  
  // Replace ,BUY_Average as buyingsight with ,'' as buyingsight
  const targetPattern = /,BUY_Average\s+as\s+buyingsight/i;
  if (targetPattern.test(content)) {
    content = content.replace(targetPattern, ",'' as buyingsight");
    fs.writeFileSync(p, content, 'utf-8');
    console.log(`✅ Updated bot_exchange_rate.aspx.cs at: ${p}`);
  } else {
    console.log(`⚠️ Target pattern not found in ${p}`);
  }
}
