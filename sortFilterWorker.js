// sortFilterWorker.js

// --- Helper Functions (Copied/Adapted) ---

// Determines if a column is primarily numeric based on sample values
function isColumnNumeric(sampleValues) {
    // Check if all non-empty values are numbers or can be converted to numbers easily
    return sampleValues.every(val => {
        const strVal = String(val).trim();
        // Consider empty strings or purely numeric strings (including decimals)
        return strVal === '' || (!isNaN(strVal) && !isNaN(parseFloat(strVal)));
    });
}

// Basic number parsing that handles commas and potential currency/percentage
function parseFormattedNumber(value) {
    if (value == null || value === '') return NaN;
    // Remove common non-numeric prefixes/suffixes for basic check
    let cleanedValue = String(value).replace(/[$,]/g, '').trim();
    // Handle percentage if it's just a number followed by %
    if (cleanedValue.endsWith('%')) {
        cleanedValue = cleanedValue.slice(0, -1);
    }
    const num = parseFloat(cleanedValue);
    return isNaN(num) ? NaN : num;
}

// --- Sorting Logic ---
function performSort(data, column, direction) {
    if (!column || column === 'No.') {
        // If no sort column or sorting by row number, return a copy as is or reset order
        // Assuming data order represents original "No." order
        return [...data];
    }

    // Sample values to determine sort type
    const sampleValues = data.slice(0, Math.min(100, data.length)).map(row => row[column]);
    const isNumeric = isColumnNumeric(sampleValues);

    let sortedData = [...data]; // Work on a copy

    sortedData.sort((a, b) => {
        let valA = a[column];
        let valB = b[column];

        // Handle empty/null values - sort them last
        if (valA == null || valA === '') {
            return direction === 'asc' ? 1 : -1;
        }
        if (valB == null || valB === '') {
            return direction === 'asc' ? -1 : 1;
        }

        if (isNumeric) {
             // Attempt numeric comparison
            const numA = parseFormattedNumber(valA);
            const numB = parseFormattedNumber(valB);

            if (!isNaN(numA) && !isNaN(numB)) {
                // Both are valid numbers
                return direction === 'asc' ? numA - numB : numB - numA;
            } else {
                // One or both couldn't be parsed as numbers, fallback to string
                valA = String(valA);
                valB = String(valB);
            }
        }
        // Default to string comparison
        const strA = String(valA).toLowerCase().trim();
        const strB = String(valB).toLowerCase().trim();

        if (strA < strB) {
            return direction === 'asc' ? -1 : 1;
        } else if (strA > strB) {
            return direction === 'asc' ? 1 : -1;
        }
        return 0; // Equal
    });

    return sortedData;
}


// --- Filtering Logic ---
// Evaluates a simple condition string against a data row
// This is a simplified version based on your main code's `evaluateCondition`
function evaluateCondition(expr, row) {
     // Basic replacements for logical operators (be very careful with eval)
    let safeExpr = expr.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');

    // Replace column names with their values (stringified or numeric)
    safeExpr = safeExpr.replace(/([a-zA-Z_][a-zA-Z0-9_]*)|(\$?[\d,]+\.?\d*)%?/g, (match) => {
        if (row.hasOwnProperty(match)) {
            const val = row[match];
            // Try to get a numeric value for comparison
            const num = parseFormattedNumber(val);
            if (!isNaN(num)) {
                return num;
            } else {
                // If not numeric, wrap string in quotes for JS eval
                // This is a significant security risk if expr comes from untrusted input!
                // Ensure expr is sanitized/controlled.
                return JSON.stringify(String(val)); // Escape quotes etc.
            }
        }
        // If not a known column, leave it (might be a literal number)
        // This is risky, but matches the pattern from the main code.
        // A proper parser would be better.
        return match;
    });

    try {
        // Using eval is dangerous. This assumes expr is safe.
        // In production, use a proper expression parser library.
        // For demonstration, we proceed with caution.
        // eslint-disable-next-line no-eval
        return eval(safeExpr); // Evaluate the constructed JS expression
    } catch (e) {
        console.error("Error evaluating expression in worker:", safeExpr, e);
        throw new Error(`Invalid filter expression: ${expr}`);
    }
}


// --- Main Worker Message Listener ---
self.addEventListener('message', function(e) {
    const { action, data, column, direction, filterExpr, filters } = e.data;

    try {
        let resultData = data; // Start with the provided data

        if (action === 'sort') {
            resultData = performSort(data, column, direction);
            self.postMessage({ status: 'success', action: 'sort', sortedData: resultData });

        } else if (action === 'filter') {
             // Basic filter: object with key-value pairs (like your setupFilters)
            if (filters && typeof filters === 'object') {
                 resultData = data.filter(item => {
                    return Object.entries(filters).every(([col, val]) => {
                        let cellText = item[col]?.toString().toLowerCase() || '';
                        return cellText.includes(val.toLowerCase());
                    });
                });
                 self.postMessage({ status: 'success', action: 'filter', filteredData: resultData });
            }
            // Advanced filter: expression string (like your advanced filter)
            else if (filterExpr && typeof filterExpr === 'string') {
                resultData = data.filter(row => evaluateCondition(filterExpr, row));
                self.postMessage({ status: 'success', action: 'filter', filteredData: resultData });
            } else {
                 throw new Error("Invalid filter parameters for worker.");
            }

        } else if (action === 'sortAndFilter') {
             // Perform filter first, then sort
             let filteredData = data;
             if (filters && typeof filters === 'object') {
                  filteredData = data.filter(item => {
                    return Object.entries(filters).every(([col, val]) => {
                        let cellText = item[col]?.toString().toLowerCase() || '';
                        return cellText.includes(val.toLowerCase());
                    });
                });
             } else if (filterExpr && typeof filterExpr === 'string') {
                filteredData = data.filter(row => evaluateCondition(filterExpr, row));
             }
             // Now sort the filtered data
             const sortedData = performSort(filteredData, column, direction);
             self.postMessage({ status: 'success', action: 'sortAndFilter', resultData: sortedData });

        } else {
            throw new Error(`Unsupported action: ${action}`);
        }

    } catch (error) {
        console.error("Error in sortFilterWorker:", error);
        self.postMessage({ status: 'error', message: error.message, action });
    }
});

// Optional: Listen for termination message
self.addEventListener('message', function(e) {
    if (e.data && e.data.action === 'terminate') {
        self.close();
    }
});