'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ComputerVisionClient } = require('@azure/cognitiveservices-computervision');
const { ApiKeyCredentials } = require('@azure/ms-rest-js');
const mongoose = require('mongoose');
const Nutrition = require('./models/nutritionModel'); // Import the nutrition model

// Load predefined nutritional data
const nutritionData = require('./nutritionData.json');

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1); // Terminate the script with error
  });

// Azure credentials
const key = process.env.AZURE_VISION_KEY;
const endpoint = process.env.AZURE_VISION_ENDPOINT;

// Azure Computer Vision client
const computerVisionClient = new ComputerVisionClient(
  new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': key } }), 
  endpoint
);

const sleep = require('util').promisify(setTimeout);

// Readline setup to capture user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Capture user inputs
rl.question('Enter your User ID: ', (userId) => {
  rl.question('Enter the image path: ', (imagePath) => {
    identifyAndProcessImage(imagePath, userId);  // Process image and save data
  });
});

// Function to identify and process the image
async function identifyAndProcessImage(imagePath, userId) {
  try {
    console.log('\nProcessing image:', path.basename(imagePath));

    // Read the image using Azure Computer Vision API
    const text = await readImageText(imagePath);
    console.log('Recognized Text:', text); // Log the recognized text

    let nutritionInfo = extractNutritionInfo(text);

    if (nutritionInfo.calories === 0 && nutritionInfo.fat === 0 && nutritionInfo.protein === 0 && nutritionInfo.carbs === 0) {
      // If no nutritional information is found, identify and count fruits or vegetables
      const description = await describeImage(imagePath);
      console.log('Image Description:', description); // Log the description
      const identifiedItems = identifyItems(description);
      if (identifiedItems.length > 0) {
        nutritionInfo = calculateApproximateNutrition(identifiedItems);
        console.log('Calculated Approximate Nutrition Info:', nutritionInfo);
      } else {
        console.log('Could not extract nutritional information or identify items. Please upload a valid image.');
        rl.close();
        return;
      }
    } else {
      console.log('Extracted Nutrition Info:', nutritionInfo);
    }

    await saveNutritionData(userId, new Date().toISOString().split('T')[0], nutritionInfo);
    rl.close();
  } catch (err) {
    console.error('Error processing the image:', err);
    rl.close();
  }
}

// Function to read text from the image using Azure Computer Vision API
async function readImageText(imagePath) {
  const streamResponse = await computerVisionClient.readInStream(() => fs.createReadStream(imagePath));
  const operationLocation = streamResponse.operationLocation;
  const operationId = operationLocation.substring(operationLocation.lastIndexOf('/') + 1);

  let readOpResult;
  while (true) {
    readOpResult = await computerVisionClient.getReadResult(operationId);
    if (readOpResult.status === 'succeeded' || readOpResult.status === 'failed') {
      break;
    }
    await sleep(1000); // Wait before checking again
  }

  if (readOpResult.status === 'succeeded') {
    console.log('Azure Vision API Response:', readOpResult); // Log the API response
    return readOpResult.analyzeResult.readResults.map(result =>
      result.lines.map(line => line.text).join(' ')
    ).join('\n');
  } else {
    throw new Error('Text recognition failed');
  }
}

// Function to describe the image using Azure Computer Vision API
async function describeImage(imagePath) {
  const descriptionResponse = await computerVisionClient.describeImageInStream(() => fs.createReadStream(imagePath));
  console.log('Azure Vision API Description Response:', descriptionResponse); // Log the API response
  return descriptionResponse.captions[0].text;
}

// Function to extract nutritional information from the recognized text
function extractNutritionInfo(text) {
  const nutritionInfo = {
    calories: 0,
    fat: 0,
    protein: 0,
    carbs: 0
  };

  const caloriesMatch = text.match(/calories\s+(\d+)/i);
  const fatMatch = text.match(/total\s+fat\s+(\d+)/i);
  const proteinMatch = text.match(/protein\s+(\d+)/i);
  const carbsMatch = text.match(/carbohydrate\s+(\d+)/i);

  if (caloriesMatch) nutritionInfo.calories = parseInt(caloriesMatch[1]);
  if (fatMatch) nutritionInfo.fat = parseInt(fatMatch[1]);
  if (proteinMatch) nutritionInfo.protein = parseInt(proteinMatch[1]);
  if (carbsMatch) nutritionInfo.carbs = parseInt(carbsMatch[1]);

  return nutritionInfo;
}

// Function to identify items from the description
function identifyItems(description) {
  const items = Object.keys(nutritionData);
  const identifiedItems = [];

  for (const item of items) {
    const regex = new RegExp(`\\b${item}\\b`, 'gi');
    const matches = description.match(regex);
    if (matches) {
      identifiedItems.push({ name: item, count: matches.length });
    }
  }

  // Handle cases like "a group of apples"
  if (description.includes('group of apples')) {
    identifiedItems.push({ name: 'apple', count: 5 }); // Assuming a group contains 5 apples
  }

  return identifiedItems;
}

// Function to calculate approximate nutrition based on identified items
function calculateApproximateNutrition(identifiedItems) {
  let totalNutrition = { calories: 0, fat: 0, protein: 0, carbs: 0 };

  for (const item of identifiedItems) {
    const nutritionInfo = nutritionData[item.name];
    if (nutritionInfo) {
      totalNutrition.calories += nutritionInfo.calories * item.count;
      totalNutrition.fat += nutritionInfo.fat * item.count;
      totalNutrition.protein += nutritionInfo.protein * item.count;
      totalNutrition.carbs += nutritionInfo.carbs * item.count;
    }
  }

  return totalNutrition;
}

// Function to save nutrition data to MongoDB
async function saveNutritionData(userId, date, nutritionData) {
  try {
    // Find existing document for the user and date
    const existingData = await Nutrition.findOne({ userId, date });

    if (existingData) {
      // Add the new nutrition data to the existing record
      existingData.calories += nutritionData.calories;
      existingData.fat += nutritionData.fat;
      existingData.protein += nutritionData.protein;
      existingData.carbs += nutritionData.carbs;

      // Save the updated data to the database
      await existingData.save();
      console.log('Updated nutrition data saved to MongoDB.');
      console.log('Updated Data:', existingData);  // Display the updated data

      // Calculate remaining nutrition
      const remainingNutrition = {
        calories: existingData.dailyCalories - existingData.calories,
        fat: existingData.dailyFat - existingData.fat,
        protein: existingData.dailyProtein - existingData.protein,
        carbs: existingData.dailyCarbs - existingData.carbs
      };
      console.log('Remaining Nutrition:', remainingNutrition);
      rl.close();
      process.exit(0); // Terminate the script
    } else {
      // Ask for daily nutritional goals
      askDailyGoals(userId, date, nutritionData);
    }
  } catch (err) {
    console.error('Error saving nutrition data to MongoDB:', err);
    process.exit(1); // Terminate the script with error
  }
}

// Function to ask for daily nutritional goals
function askDailyGoals(userId, date, nutritionData) {
  rl.question('Enter your daily calories goal: ', (dailyCalories) => {
    rl.question('Enter your daily fat goal (g): ', (dailyFat) => {
      rl.question('Enter your daily protein goal (g): ', (dailyProtein) => {
        rl.question('Enter your daily carbs goal (g): ', (dailyCarbs) => {
          const newNutritionData = new Nutrition({
            userId,
            date,
            calories: nutritionData.calories,
            fat: nutritionData.fat,
            protein: nutritionData.protein,
            carbs: nutritionData.carbs,
            dailyCalories: parseInt(dailyCalories),
            dailyFat: parseInt(dailyFat),
            dailyProtein: parseInt(dailyProtein),
            dailyCarbs: parseInt(dailyCarbs)
          });

          newNutritionData.save()
            .then(() => {
              console.log('New nutrition data saved to MongoDB.');
              console.log('New Data:', newNutritionData);  // Display the newly saved data

              // Calculate remaining nutrition
              const remainingNutrition = {
                calories: newNutritionData.dailyCalories - newNutritionData.calories,
                fat: newNutritionData.dailyFat - newNutritionData.fat,
                protein: newNutritionData.dailyProtein - newNutritionData.protein,
                carbs: newNutritionData.dailyCarbs - newNutritionData.carbs
              };
              console.log('Remaining Nutrition:', remainingNutrition);
              rl.close();
              process.exit(0); // Terminate the script
            })
            .catch((err) => {
              console.error('Error saving new nutrition data to MongoDB:', err);
              rl.close();
              process.exit(1); // Terminate the script with error
            });
        });
      });
    });
  });
}