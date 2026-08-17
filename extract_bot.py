import zipfile
import xml.etree.ElementTree as ET
import json
import re

xlsx_path = '/Users/delta/Documents/-- VibeCode/FxCurrency/BOT-Backward/Bot07.26.xlsx'

thai_months = {
    'มกราคม': '01', 'กุมภาพันธ์': '02', 'มีนาคม': '03', 'เมษายน': '04',
    'พฤษภาคม': '05', 'มิถุนายน': '06', 'กรกฎาคม': '07', 'กรกฏาคม': '07',
    'สิงหาคม': '08', 'กันยายน': '09', 'ตุลาคม': '10', 'พฤศจิกายน': '11', 'ธันวาคม': '12'
}

with zipfile.ZipFile(xlsx_path) as z:
    wb_xml = ET.fromstring(z.read('xl/workbook.xml'))
    ns = {
        'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
        'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    }
    wb_rels_xml = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rel_ns = {'rel': 'http://schemas.openxmlformats.org/package/2006/relationships'}
    rel_map = {rel.attrib['Id']: rel.attrib['Target'] for rel in wb_rels_xml.findall('rel:Relationship', rel_ns)}

    shared_strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        sst_xml = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in sst_xml.findall('main:si', ns):
            text_parts = [t_node.text for t_node in si.findall('.//main:t', ns) if t_node.text]
            shared_strings.append(''.join(text_parts))

    def get_cell(row, col_letter):
        for c in row.findall('main:c', ns):
            ref = c.attrib.get('r', '')
            if ref.startswith(col_letter) and ref[len(col_letter):].isdigit():
                c_type = c.attrib.get('t')
                v = c.find('main:v', ns)
                val = v.text if v is not None else None
                if c_type == 's' and val is not None:
                    val = shared_strings[int(val)]
                return val
        return None

    sheets = []
    for s in wb_xml.findall('main:sheets/main:sheet', ns):
        name = s.attrib['name']
        r_id = s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        target = rel_map[r_id]
        if not target.startswith('xl/'):
            target = 'xl/' + target
        sheets.append((name, target))

    all_days = []

    for name, target in sheets:
        if name == 'รวมไฟล์':
            continue
        sheet_xml = ET.fromstring(z.read(target))
        rows = sheet_xml.findall('main:sheetData/main:row', ns)
        if not rows:
            continue
        title = get_cell(rows[0], 'A') or ''
        
        date_iso = None
        for m_th, m_num in thai_months.items():
            if m_th in title:
                match = re.search(r'วันที่\s*(\d+)\s*' + m_th + r'\s*(\d{4})', title)
                if match:
                    d_day = int(match.group(1))
                    d_year = int(match.group(2)) - 543
                    date_iso = f'{d_year:04d}-{m_num}-{d_day:02d}'
                break
        
        if not date_iso:
            continue

        day_records = []
        for r in rows:
            r_idx = int(r.attrib.get('r', 0))
            c_code = get_cell(r, 'B')
            if not c_code or len(c_code.strip()) != 3 or not c_code.strip().isupper() or c_code.strip() == 'THB':
                continue
            c_code = c_code.strip()
            c_country = get_cell(r, 'A') or c_code
            col_c = get_cell(r, 'C')
            col_d = get_cell(r, 'D')
            col_e = get_cell(r, 'E')
            
            def to_f(v):
                if v is None or v == '' or v == '-':
                    return None
                try:
                    return float(v)
                except:
                    return None

            c_val = to_f(col_c)
            d_val = to_f(col_d)
            e_val = to_f(col_e)
            
            is_section_1 = (r_idx <= 27)

            if is_section_1:
                # Section 1 (Commercial bank averages)
                sell_tt = e_val
                sell_notes = e_val
                if c_code == 'USD':
                    buy_sight = c_val
                    buy_tt = c_val
                    buy_transfer = d_val
                    buy_notes = d_val
                else:
                    buy_sight = c_val if c_val is not None else d_val
                    buy_tt = c_val if c_val is not None else d_val
                    buy_transfer = d_val if d_val is not None else c_val
                    buy_notes = d_val if d_val is not None else c_val
            else:
                # Section 2 (Foreign market cross rates)
                sell_tt = e_val
                sell_notes = e_val
                buy_transfer = d_val
                buy_sight = d_val
                buy_tt = d_val
                buy_notes = d_val

            day_records.append({
                'rate_date': date_iso,
                'source': 'BOT',
                'currency': c_code,
                'currency_label': c_country.strip(),
                'sell_tt': sell_tt,
                'sell_notes': sell_notes,
                'buy_tt': buy_tt,
                'buy_sight': buy_sight,
                'buy_transfer': buy_transfer,
                'buy_notes': buy_notes,
                'mid_rate': None,
                'bank_timestamp': f'{date_iso}T00:00:00+00:00',
                'raw_data': {
                    'period': date_iso,
                    'sheet': name,
                    'section': 1 if is_section_1 else 2,
                    'country_th': c_country.strip(),
                    'col_c': col_c,
                    'col_d': col_d,
                    'col_e': col_e,
                    'imported_at': 'backward_import'
                }
            })

        all_days.append({
            'date': date_iso,
            'sheet': name,
            'records': day_records
        })

print(json.dumps(all_days, ensure_ascii=False))
