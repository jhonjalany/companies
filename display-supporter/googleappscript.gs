function doPost(e) {
  try {
    // Log raw input for debugging
    Logger.log('Raw Input:', e.postData.contents);

    const sheetId = '1O_S-2HSXClKCXM20R5nCF0Jr0YfGG5WfdBKiXkEUzo4'; // Replace with your Spreadsheet ID
    const sheetName = 'Sheet1';
    const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);

    // Define expected headers
    const expectedHeaders = [
      'Timestamp',
      'userID',
      'username',
      'profileLink',
      'profilePictureUrl',
      'totalLikes',
      'totalCoins'
    ];

    // Check if header exists and matches expected
    const currentHeader = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
    if (!arraysEqual(currentHeader, expectedHeaders)) {
      sheet.clear(); // Clear all data
      sheet.appendRow(expectedHeaders); // Set correct headers
    }

    // Parse incoming JSON data
    const data = JSON.parse(e.postData.contents);
    Logger.log('Parsed Data:', data);

    // Get all rows
    const rows = sheet.getDataRange().getValues();
    const headerRow = rows[0];
    const dataRows = rows.slice(1);

    // Find column indices
    const userIdColIndex = headerRow.indexOf('userID');
    if (userIdColIndex === -1) throw new Error("Header 'userID' not found");

    // Map existing users by userID
    const sheetDataMap = {};
    dataRows.forEach(row => {
      const userId = row[userIdColIndex];
      if (userId) sheetDataMap[userId] = row;
    });

    // Process each user
    for (let userId in data) {
      const user = data[userId];

      const incomingLikes = parseInt(user.totalLikesCountInPast5Seconds) || 0;
      const incomingCoins = parseInt(user.totalCoinOrGiftCountInPast5Seconds) || 0;

      if (sheetDataMap[userId]) {
        // Update existing user
        const rowIndex = dataRows.findIndex(row => row[userIdColIndex] === userId) + 1;
        const currentRow = sheetDataMap[userId];

        const currentLikes = parseInt(currentRow[headerRow.indexOf('totalLikes')]) || 0;
        const currentCoins = parseInt(currentRow[headerRow.indexOf('totalCoins')]) || 0;

        currentRow[headerRow.indexOf('Timestamp')] = new Date();
        currentRow[headerRow.indexOf('totalLikes')] = currentLikes + incomingLikes;
        currentRow[headerRow.indexOf('totalCoins')] = currentCoins + incomingCoins;

        sheet.getRange(rowIndex + 1, 1, 1, currentRow.length).setValues([currentRow]);
      } else {
        // Add new user
        const newRow = [
          new Date(),
          userId,
          user.username,
          user.profileLink,
          user.profilePictureUrl,
          incomingLikes,
          incomingCoins
        ];
        sheet.appendRow(newRow);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ result: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error in doPost:', err.toString());
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ✅ doGet() — returns full dataset as JSON
function doGet() {
  const sheetId = '1O_S-2HSXClKCXM20R5nCF0Jr0YfGG5WfdBKiXkEUzo4'; // Same as above
  const sheetName = 'Sheet1';
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);

  const rows = sheet.getDataRange().getValues();

  const headers = rows[0];
  const dataRows = rows.slice(1);

  const userIdIndex = headers.indexOf('userID');
  const usernameIndex = headers.indexOf('username');
  const profileLinkIndex = headers.indexOf('profileLink');
  const profilePictureUrlIndex = headers.indexOf('profilePictureUrl');
  const totalLikesIndex = headers.indexOf('totalLikes');
  const totalCoinsIndex = headers.indexOf('totalCoins');

  const formattedData = dataRows
    .filter(row => row[userIdIndex]) // Skip empty rows
    .map(row => ({
      userID: row[userIdIndex],
      username: row[usernameIndex],
      profileLink: row[profileLinkIndex],
      profilePictureUrl: row[profilePictureUrlIndex],
      totalLikes: parseInt(row[totalLikesIndex]) || 0,
      totalCoinsOrGifts: parseInt(row[totalCoinsIndex]) || 0
    }));

  return ContentService.createTextOutput(JSON.stringify(formattedData))
    .setMimeType(ContentService.MimeType.JSON);
}

// Helper function to compare arrays (case-insensitive, trimmed)
function arraysEqual(a1, a2) {
  if (a1.length !== a2.length) return false;
  return a1.every((val, i) =>
    val?.toString().trim().toLowerCase() === a2[i]?.toString().trim().toLowerCase()
  );
}