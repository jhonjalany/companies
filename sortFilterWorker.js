// sortFilterWorker.js

// --- Helper Functions (Copied/Adapted) ---

// Determines if a column is primarily numeric based on sample values
function isColumnNumeric(sampleValues) {
    return sampleValues.every(val => {
        const strVal = String(val).trim();
        return strVal === '' || (!isNaN(strVal) && !isNaN(parseFloat(strVal)));
    });
}

// Basic number parsing that handles commas and potential currency/percentage
function parseFormattedNumber(value) {
    if (value == null) return NaN;
    const strValue = String(value).trim().replace(/,/g, '');
    if (strValue.endsWith('%')) {
        const num = parseFloat(strValue);
        return isNaN(num) ? NaN : num / 100;
    }
    if (strValue.startsWith('$')) {
        return parseFloat(strValue.substring(1));
    }
    return parseFloat(strValue);
}

// Escape special regex characters
function escapeRegExp(string) {
   return string.replace(/[.*+?^${}()|[\\\]]/g, '\\$&'); // $& means the whole matched string
}

// --- Enhanced Expression Evaluation ---

// Preprocesses the expression to handle '== unique' conditions
// Returns { processedExpr: string, uniqueChecks: Map }
function preprocessExpression(expr, fullData, visibleColumns) {
    const uniqueChecks = new Map(); // Map to store { columnName: Set() }
    let processedExpr = expr;

    // 1. Find all 'column == unique' patterns (case-insensitive, allowing spaces around ==)
    // Match column names that could contain spaces (based on visibleColumns)
    const escapedColumnNames = visibleColumns.map(name => escapeRegExp(name));
    const allColumnNamesPattern = escapedColumnNames.join('|');
    // This regex finds 'columnName == unique' (or variations like '==unique')
    const uniqueCheckRegex = new RegExp(`(${allColumnNamesPattern})\\s*==\\s*unique`, 'gi');

    let match;
    // Use a global regex to find all matches
    while ((match = uniqueCheckRegex.exec(expr)) !== null) {
        const fullMatch = match[0];
        const columnName = match[1];

        // Store the unique values set for this column if not already done
        if (!uniqueChecks.has(columnName)) {
            const uniqueSet = new Set();
            // Pre-populate the set with values from the full dataset
            fullData.forEach(row => {
                const val = row[columnName];
                // Normalize value for uniqueness check (e.g., trim, lowercase if needed)
                // Using strict string representation for now
                const normalizedVal = val == null ? '' : String(val); // Could normalize further if needed
                uniqueSet.add(normalizedVal);
            });
            uniqueChecks.set(columnName, uniqueSet);
        }

        // Replace the 'column == unique' part in the expression with a placeholder
        // We'll replace this placeholder with the actual boolean result later (during row evaluation)
        // Use a unique placeholder unlikely to conflict with column names or data
        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
        processedExpr = processedExpr.replace(fullMatch, placeholder);
    }

    return { processedExpr, uniqueChecks };
}


// Evaluates a single condition (e.g., "Age > 30", "Name == 'John'")
// Returns true/false or null if the condition cannot be evaluated
function evaluateSingleCondition(conditionStr, row, fullData, visibleColumns) {
    // Basic replacements for logical operators (only for final eval, not preprocessing)
    let safeExpr = conditionStr.trim()
        .replace(/\bAND\b/gi, '&&')
        .replace(/\bOR\b/gi, '||');

    // Handle percentage literals (e.g., 10%)
    safeExpr = safeExpr.replace(/\b(\d+(?:\.\d+)?)%/g, (match, numberStr) => {
        const decimalValue = parseFloat(numberStr) / 100;
        return decimalValue.toString();
    });

    // Remove leading '=' if present (standard for formulas)
    if (safeExpr.startsWith('=')) {
        safeExpr = safeExpr.substring(1);
    }

    // --- Column Name and Literal Replacement ---
    const escapedColumnNames = visibleColumns.map(name => escapeRegExp(name));
    const allColumnNamesPattern = escapedColumnNames.join('|');
    // Match column names (precisely) OR potential number literals (including $, commas, %)
    const replacementRegex = new RegExp(`(${allColumnNamesPattern})|(\\\$?[\\d,]+\\.?\\d*)%?`, 'g');

    try {
        const safeEvalExpr = safeExpr.replace(replacementRegex, (match) => {
            // Check if the match is a column name (exists in row)
            if (row.hasOwnProperty(match)) {
                const val = row[match];
                const num = parseFormattedNumber(val);
                // Use number if possible, else stringify (wrapping in quotes for safety)
                return isNaN(num) ? JSON.stringify(val) : num;
            }
            // Otherwise, it's a literal in the expression (like $50,000 or 15%)
            const num = parseFormattedNumber(match);
            if (!isNaN(num)) {
                return num;
            }
            // If not a number, treat as string literal (wrap in quotes)
            // This handles cases where a literal string might be in the condition
            return JSON.stringify(match);
        });

        // --- Critical Security Note ---
        // Using eval is inherently dangerous. Ensure expr is sanitized and comes from a trusted source.
        // In a worker context, this risk is somewhat mitigated, but caution is still advised.
        // Consider using a safer expression parser library for production.
        // eslint-disable-next-line no-eval
        return !!eval(safeEvalExpr); // Ensure result is boolean

    } catch (e) {
        console.error("Error evaluating single condition in worker:", safeExpr, e);
        // If evaluation fails, consider the condition as false or throw an error
        // Returning null might be better to distinguish from explicit false
        return null;
    }
}

// Main function to evaluate the entire filter expression for a single row
// Handles preprocessing for '== unique' and then evaluates the rest
function evaluateCondition(expr, row, fullData, visibleColumns) {
    if (!expr || typeof expr !== 'string') {
        return true; // If no expression, include all rows
    }

    // Step 1: Preprocess the expression to find and prepare '== unique' checks
    const { processedExpr, uniqueChecks } = preprocessExpression(expr, fullData, visibleColumns);

    // If there were no '== unique' parts, evaluate the expression directly
    if (uniqueChecks.size === 0) {
        return evaluateSingleCondition(expr, row, fullData, visibleColumns);
    }

    // Step 2: Replace placeholders with actual boolean results for this row
    let finalEvalExpr = processedExpr;
    for (const [columnName, uniqueSet] of uniqueChecks.entries()) {
        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
        const rowValue = row[columnName];
        const normalizedRowValue = rowValue == null ? '' : String(rowValue); // Match normalization

        // Check if this is the *first* time we see this value in this column
        // (This logic assumes we are processing rows sequentially in filter,
        // which is generally the case for Array.filter).
        // Note: This is a simplification. The worker processes the entire dataset for
        // 'unique' sets, but the filter callback processes one row at a time.
        // The correct way is to track seen values *during filtering* for each unique check.
        // Let's correct this approach.

        // --- CORRECTED APPROACH ---
        // We need to track seen values PER COLUMN during the filtering process itself.
        // Since this function is called for each row, we need a way to persist this state
        // across calls. A closure or a higher-scoped object passed in could work.
        // However, the worker message handler creates a new `encounteredTracker` for
        // each filter operation. We can pass that tracker down.

        // Assume `evaluateCondition` receives an `encounteredTracker` object from the caller
        // This object will be { "ColA": Set(), "ColB": Set(), ... }
        // This requires modifying the call to `evaluateCondition` later.

        // For now, let's define it here but expect it to be passed in.
        // Placeholder logic corrected below in the message handler section.
    }

    // Step 3: Evaluate the final expression with boolean replacements
    // Basic replacements for logical operators
    let safeFinalExpr = finalEvalExpr
        .replace(/\bAND\b/gi, '&&')
        .replace(/\bOR\b/gi, '||');

    // Handle percentage literals globally if any remain
    safeFinalExpr = safeFinalExpr.replace(/\b(\d+(?:\.\d+)?)%/g, (match, numberStr) => {
        return (parseFloat(numberStr) / 100).toString();
    });

    try {
        // eslint-disable-next-line no-eval
        return !!eval(safeFinalExpr); // Ensure boolean result
    } catch (e) {
        console.error("Error evaluating final processed expression in worker:", safeFinalExpr, e);
        throw new Error(`Invalid filter expression after processing: ${safeFinalExpr}`);
    }
}

// --- Sorting Function ---
function performSort(dataArray, sortColumn, sortDirection) {
    if (!sortColumn || !Array.isArray(dataArray)) return dataArray;

    const dirMultiplier = sortDirection === 'desc' ? -1 : 1;
    const sampleRow = dataArray[0];
    const isNumericCol = sampleRow && isColumnNumeric(dataArray.slice(0, 10).map(r => r[sortColumn]));

    return dataArray.sort((a, b) => {
        let aVal = a[sortColumn];
        let bVal = b[sortColumn];

        if (aVal == null) aVal = '';
        if (bVal == null) bVal = '';

        if (isNumericCol) {
            const aNum = parseFormattedNumber(aVal);
            const bNum = parseFormattedNumber(bVal);
            if (!isNaN(aNum) && !isNaN(bNum)) {
                return (aNum - bNum) * dirMultiplier;
            }
            // If one is not a number, treat it as smaller (or handle NaNs consistently)
            if (isNaN(aNum) && !isNaN(bNum)) return -1 * dirMultiplier;
            if (!isNaN(aNum) && isNaN(bNum)) return 1 * dirMultiplier;
        }

        // Default string comparison (case-insensitive)
        const aStr = String(aVal).toLowerCase();
        const bStr = String(bVal).toLowerCase();
        if (aStr < bStr) return -1 * dirMultiplier;
        if (aStr > bStr) return 1 * dirMultiplier;
        return 0;
    });
}
// --- End Sorting Function ---


// --- Main Worker Message Listener ---
self.addEventListener('message', function (e) {
    // Added visibleColumns and encounteredTracker (for unique) to the destructuring
    const { action, data, column, direction, filterExpr, filters, visibleColumns } = e.data;
    // Ensure we work with a copy of the data array to avoid modifying the original passed data
    const dataCopy = Array.isArray(data) ? [...data] : [];

    // Validate that visibleColumns is provided for 'filter' or 'sortAndFilter' actions involving expressions
    if (
        (action === 'filter' || action === 'sortAndFilter') &&
        (filterExpr || (filters && typeof filters === 'object')) && // Need visibleColumns if filtering
        (!Array.isArray(visibleColumns) || visibleColumns.length === 0)
    ) {
        self.postMessage({
            status: 'error',
            message: 'visibleColumns array is required for filtering with expressions or basic filters.',
            action
        });
        return; // Stop processing if visibleColumns is missing for filtering
    }


    try {
        let resultData = dataCopy; // Start with the copied data

        if (action === 'sort') {
            resultData = performSort(dataCopy, column, direction);
            self.postMessage({ status: 'success', action: 'sort', sortedData: resultData });

        } else if (action === 'filter') {
            // Basic filter: object with key-value pairs (like your setupFilters)
            if (filters && typeof filters === 'object') {
                resultData = dataCopy.filter(item => {
                    return Object.entries(filters).every(([col, val]) => {
                        let cellText = item[col]?.toString().toLowerCase() || '';
                        return cellText.includes(val.toLowerCase());
                    });
                });
                self.postMessage({ status: 'success', action: 'filter', filteredData: resultData });
            }
            // Advanced filter: expression string (like your advanced filter)
            else if (filterExpr && typeof filterExpr === 'string') {
                // --- ENHANCED UNIQUE TRACKING FOR FILTERING ---
                // Create a tracker object to hold Sets for encountered values during filtering
                // This is scoped to this specific filter operation.
                const encounteredTracker = {};

                // --- MODIFIED evaluateCondition CALL ---
                // Pass the tracker so evaluateCondition can manage unique checks per row
                resultData = dataCopy.filter(row => {
                     // --- Preprocess for Unique Checks within Filter Loop ---
                    // This ensures uniqueness is tracked *per filter operation*, not globally.
                    const uniqueChecks = new Map(); // Map to store { columnName: Set() } for THIS expression run
                    let tempExpr = filterExpr; // Work on a copy of the expression

                    const escapedColumnNames = visibleColumns.map(name => escapeRegExp(name));
                    const allColumnNamesPattern = escapedColumnNames.join('|');
                    const uniqueCheckRegex = new RegExp(`(${allColumnNamesPattern})\\s*==\\s*unique`, 'gi');

                    let match;
                    while ((match = uniqueCheckRegex.exec(filterExpr)) !== null) {
                        const fullMatch = match[0];
                        const columnName = match[1];

                        if (!uniqueChecks.has(columnName)) {
                            uniqueChecks.set(columnName, new Set());
                        }
                        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
                        tempExpr = tempExpr.replace(fullMatch, placeholder);
                    }

                    // Now evaluate the tempExpr with unique logic applied to THIS row
                    let finalEvalExpr = tempExpr;

                    for (const [columnName, uniqueSet] of uniqueChecks.entries()) {
                        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
                        const rowValue = row[columnName];
                        const normalizedRowValue = rowValue == null ? '' : String(rowValue);

                         // Initialize tracking set for this column in the tracker if needed
                        if (!encounteredTracker[columnName]) {
                            encounteredTracker[columnName] = new Set();
                        }

                        // Check if value is unique (first time seen) in this filtering pass
                        if (encounteredTracker[columnName].has(normalizedRowValue)) {
                             // Already seen, make this part of the condition FALSE
                            finalEvalExpr = finalEvalExpr.replace(placeholder, 'false');
                        } else {
                            // First time, make it TRUE and record it
                            encounteredTracker[columnName].add(normalizedRowValue);
                            finalEvalExpr = finalEvalExpr.replace(placeholder, 'true');
                        }
                    }

                    // --- Evaluate the Final Expression for this Row ---
                    // Basic replacements for logical operators
                    let safeFinalExpr = finalEvalExpr
                        .replace(/\bAND\b/gi, '&&')
                        .replace(/\bOR\b/gi, '||');

                    // Handle percentage literals globally if any remain
                    safeFinalExpr = safeFinalExpr.replace(/\b(\d+(?:\.\d+)?)%/g, (match, numberStr) => {
                        return (parseFloat(numberStr) / 100).toString();
                    });

                    // --- Column Name and Literal Replacement for Final Eval ---
                    const replacementRegex = new RegExp(`(${allColumnNamesPattern})|(\\\$?[\\d,]+\\.?\\d*)%?`, 'g');
                    try {
                        const safeEvalExpr = safeFinalExpr.replace(replacementRegex, (match) => {
                            if (row.hasOwnProperty(match)) {
                                const val = row[match];
                                const num = parseFormattedNumber(val);
                                return isNaN(num) ? JSON.stringify(val) : num;
                            }
                            const num = parseFormattedNumber(match);
                            if (!isNaN(num)) {
                                return num;
                            }
                            return JSON.stringify(match); // Treat as string literal
                        });

                        // --- Final Evaluation ---
                        // eslint-disable-next-line no-eval
                        return !!eval(safeEvalExpr);

                    } catch (evalError) {
                         console.error("Error evaluating processed expression for row:", safeFinalExpr, evalError);
                         // Exclude row on evaluation error
                         return false;
                    }
                });

                self.postMessage({ status: 'success', action: 'filter', filteredData: resultData });
            } else {
                throw new Error("Invalid filter parameters for worker.");
            }

        } else if (action === 'sortAndFilter') {
            // Perform filter first, then sort
            let filteredData = dataCopy;

            if (filters && typeof filters === 'object') {
                filteredData = dataCopy.filter(item => {
                    return Object.entries(filters).every(([col, val]) => {
                        let cellText = item[col]?.toString().toLowerCase() || '';
                        return cellText.includes(val.toLowerCase());
                    });
                });
            } else if (filterExpr && typeof filterExpr === 'string') {
                 // --- ENHANCED UNIQUE TRACKING FOR SORTANDFILTER ---
                const encounteredTracker = {};
                 filteredData = dataCopy.filter(row => {
                    // --- Preprocess for Unique Checks within Filter Loop ---
                    const uniqueChecks = new Map();
                    let tempExpr = filterExpr;

                    const escapedColumnNames = visibleColumns.map(name => escapeRegExp(name));
                    const allColumnNamesPattern = escapedColumnNames.join('|');
                    const uniqueCheckRegex = new RegExp(`(${allColumnNamesPattern})\\s*==\\s*unique`, 'gi');

                    let match;
                    while ((match = uniqueCheckRegex.exec(filterExpr)) !== null) {
                        const fullMatch = match[0];
                        const columnName = match[1];

                        if (!uniqueChecks.has(columnName)) {
                            uniqueChecks.set(columnName, new Set());
                        }
                        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
                        tempExpr = tempExpr.replace(fullMatch, placeholder);
                    }

                    // Evaluate unique placeholders for this row
                    let finalEvalExpr = tempExpr;
                    for (const [columnName, uniqueSet] of uniqueChecks.entries()) {
                        const placeholder = `__UNIQUE_CHECK_${columnName}__`;
                        const rowValue = row[columnName];
                        const normalizedRowValue = rowValue == null ? '' : String(rowValue);

                        if (!encounteredTracker[columnName]) {
                            encounteredTracker[columnName] = new Set();
                        }

                        if (encounteredTracker[columnName].has(normalizedRowValue)) {
                            finalEvalExpr = finalEvalExpr.replace(placeholder, 'false');
                        } else {
                            encounteredTracker[columnName].add(normalizedRowValue);
                            finalEvalExpr = finalEvalExpr.replace(placeholder, 'true');
                        }
                    }

                    // Evaluate final expression
                    let safeFinalExpr = finalEvalExpr
                        .replace(/\bAND\b/gi, '&&')
                        .replace(/\bOR\b/gi, '||');
                    safeFinalExpr = safeFinalExpr.replace(/\b(\d+(?:\.\d+)?)%/g, (match, numberStr) => {
                        return (parseFloat(numberStr) / 100).toString();
                    });

                    const replacementRegex = new RegExp(`(${allColumnNamesPattern})|(\\\$?[\\d,]+\\.?\\d*)%?`, 'g');
                    try {
                        const safeEvalExpr = safeFinalExpr.replace(replacementRegex, (match) => {
                            if (row.hasOwnProperty(match)) {
                                const val = row[match];
                                const num = parseFormattedNumber(val);
                                return isNaN(num) ? JSON.stringify(val) : num;
                            }
                            const num = parseFormattedNumber(match);
                            if (!isNaN(num)) {
                                return num;
                            }
                            return JSON.stringify(match);
                        });

                        // eslint-disable-next-line no-eval
                        return !!eval(safeEvalExpr);

                    } catch (evalError) {
                        console.error("Error evaluating processed expression for row (sortAndFilter):", safeFinalExpr, evalError);
                        return false;
                    }
                });
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
self.addEventListener('message', function (e) {
    if (e.data && e.data.action === 'terminate') {
        self.close();
    }
});
