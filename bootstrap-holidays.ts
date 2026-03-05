import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function bootstrap() {
    try {
        const res = await axios.get('https://apigw1.bot.or.th/bot/public/financial-institutions-holidays/?year=2026', {
            headers: {
                'X-IBM-Client-Id': '2c1e8d1a-6d04-4df1-8da1-3de83b0daef4',
                'accept': 'application/json'
            }
        });

        const data = res.data.result.data;
        console.log(`Fetched ${data.length} holidays from BOT API for 2026:`);

        const inserts = data.map((item: any) => ({
            holiday_date: item.Date,
            description: item.HolidayDescriptionThai
        }));

        const { data: inserted, error } = await supabase
            .from('bank_holidays')
            .upsert(inserts, { onConflict: 'holiday_date' })
            .select();

        if (error) {
            console.error('Supabase Error:', error.message);
        } else {
            console.log('Successfully inserted into DB:', inserted?.length, 'records.');
            for (const item of inserted || []) {
                console.log(`- ${item.holiday_date}: ${item.description}`);
            }
        }

    } catch (e: any) {
        console.error('Failed to fetch from BOT API:', e.message);
    }
}

bootstrap();
