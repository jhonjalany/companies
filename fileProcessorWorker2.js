// fileProcessorWorker.js

// Import necessary libraries *inside* the worker if they are also compatible with Workers.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

self.addEventListener('message', async function(e) {
    const { fileData, fileType, fileName } = e.data; // Receive data from main thread

    try {
        let sheetDataMap = {};
        let error = null;

        if (fileType === 'csv') {
            // --- CSV Processing ---
            // Expect fileData to be the CSV text string directly from the main thread
            let csvText = fileData; // This is now the string content

            if (typeof csvText !== 'string') {
                 throw new Error("CSV data received by worker is not a string.");
            }

            // Basic CSV parsing logic (adapted from your snippet)
            const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
            if (lines.length === 0) {
                throw new Error("CSV file is empty or could not be parsed.");
            }
            // Parse headers, handling potential quotes
            const headers = lines[0].split(',').map(h => {
                let header = h.trim();
                if (header.startsWith('"') && header.endsWith('"')) {
                    header = header.substring(1, header.length - 1);
                }
                return header;
            });

            for (let i = 1; i < lines.length; i++) {
                const currentLine = lines[i];
                if (!currentLine) continue; // Skip empty lines
                const values = currentLine.split(',');
                const obj = {};
                headers.forEach((header, index) => {
                    let value = values[index] ? values[index].trim() : '';
                    // Handle potential quotes around values
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.substring(1, value.length - 1);
                    }
                    obj[header] = value;
                });
                // Assume a default sheet name for CSV, e.g., "Sheet1"
                if (!sheetDataMap["Sheet1"]) sheetDataMap["Sheet1"] = [];
                sheetDataMap["Sheet1"].push(obj);
            }

            // Add Row Number (as in your original code)
            if (sheetDataMap["Sheet1"]) {
                 sheetDataMap["Sheet1"].forEach((row, idx) => {
                     row['Row Number'] = idx + 1;
                 });
            }


        } else if (fileType === 'xlsx' || fileType === 'xls') {
            // --- XLSX Processing ---
            // Expect fileData to be an ArrayBuffer for XLSX
            if (!(fileData instanceof ArrayBuffer)) {
                 throw new Error("XLSX data received by worker is not an ArrayBuffer.");
            }
            const workbook = XLSX.read(fileData, { type: 'array' });
            workbook.SheetNames.forEach(name => {
                const sheet = workbook.Sheets[name];
                // Convert sheet to JSON, including all cells
                sheetDataMap[name] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                // Add Row Number for reference if needed later
                sheetDataMap[name].forEach((row, idx) => {
                    row['Row Number'] = idx + 1;
                });
            });
        } else {
            throw new Error(`Unsupported file type: ${fileType}`);
        }

        // Send the processed data back to the main thread
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
