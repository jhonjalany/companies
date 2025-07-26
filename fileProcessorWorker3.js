// fileProcessorWorker.js

// Import necessary libraries *inside* the worker if they are also compatible with Workers.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

function convertDatesToStrings(obj) {
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const val = obj[key];
            if (val instanceof Date) {
                obj[key] = val.toISOString().split('T')[0]; // e.g., "2024-12-31"
            } else if (typeof val === 'string' && isoDateRegex.test(val)) {
                // Already an ISO date string? Normalize it
                obj[key] = new Date(val).toISOString().split('T')[0];
            } else if (typeof val === 'number' && val > 1000 && !isNaN(new Date(val).getTime())) {
                // Possibly Excel date serial number (heuristic)
                const date = new Date((val - 25569) * 86400 * 1000); // Excel to JS date
                if (!isNaN(date.getTime())) {
                    obj[key] = date.toISOString().split('T')[0];
                }
            }
        }
    }
    return obj;
}

self.addEventListener('message', async function(e) {
    const { fileData, fileType, fileName } = e.data;

    try {
        let sheetDataMap = {};
        let error = null;

        if (fileType === 'csv') {
            let csvText = fileData;
            if (typeof csvText !== 'string') {
                throw new Error("CSV data received by worker is not a string.");
            }

            const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
            if (lines.length === 0) {
                throw new Error("CSV file is empty or could not be parsed.");
            }

            const headers = lines[0].split(',').map(h => {
                let header = h.trim();
                if (header.startsWith('"') && header.endsWith('"')) {
                    header = header.substring(1, header.length - 1);
                }
                return header;
            });

            for (let i = 1; i < lines.length; i++) {
                const currentLine = lines[i];
                if (!currentLine) continue;
                const values = currentLine.split(',');
                const obj = {};
                headers.forEach((header, index) => {
                    let value = values[index] ? values[index].trim() : '';
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.substring(1, value.length - 1);
                    }
                    obj[header] = value;
                });
                convertDatesToStrings(obj); // Convert any detected date fields to string
                if (!sheetDataMap["Sheet1"]) sheetDataMap["Sheet1"] = [];
                sheetDataMap["Sheet1"].push(obj);
            }

            if (sheetDataMap["Sheet1"]) {
                sheetDataMap["Sheet1"].forEach((row, idx) => {
                    row['Row Number'] = idx + 1;
                });
            }

        } else if (fileType === 'xlsx' || fileType === 'xls') {
            if (!(fileData instanceof ArrayBuffer)) {
                throw new Error("XLSX data received by worker is not an ArrayBuffer.");
            }

            const workbook = XLSX.read(fileData, {
                type: 'array',
                raw: true,
                cellDates: false, // Don't auto-parse dates
                dateNF: 'yyyy-mm-dd' // Format dates as strings
            });

            workbook.SheetNames.forEach(name => {
                const sheet = workbook.Sheets[name];
                let jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                jsonData = jsonData.map(row => {
                    convertDatesToStrings(row); // Ensure all dates are strings
                    return row;
                });
                jsonData.forEach((row, idx) => {
                    row['Row Number'] = idx + 1;
                });
                sheetDataMap[name] = jsonData;
            });

        } else {
            throw new Error(`Unsupported file type: ${fileType}`);
        }

        self.postMessage({ status: 'success', sheetDataMap: sheetDataMap, fileName: fileName });

    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ status: 'error', message: err.message, fileName: fileName });
    }
});

// Optional: Listen for termination message if needed
self.addEventListener('message', function(e) {
    if (e.data && e.data.action === 'terminate') {
        self.close();
    }
});