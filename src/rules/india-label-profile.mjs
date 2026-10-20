/**
 * The app does not make a legal compliance determination. This small profile
 * keeps the label interpretation used in the report in one versioned place.
 * It is intentionally conservative: a position in the list is not a
 * percentage and an absent declaration is not treated as a negative claim.
 */
export const INDIA_LABEL_PROFILE = {
  id: 'india-fssai-label-v1',
  jurisdiction: 'India',
  ingredientOrderRule:
    'Ingredients are generally declared in descending order by weight at the time of manufacture, subject to applicable exceptions and rules for compound ingredients or small-quantity ingredients.',
  allergenGroups: [
    'cereals containing gluten',
    'crustaceans',
    'eggs',
    'fish',
    'peanuts',
    'soybeans',
    'milk',
    'tree nuts',
    'mustard',
    'sulphites',
  ],
  scoringNotice:
    'This is a transparent label signal, not a universal health score, allergy-safety rating, or medical recommendation.',
  nutritionInformation:
    'For the Indian label profile, the core nutrition fields are energy, protein, carbohydrate, total sugars, added sugars, total fat, saturated fat, trans fat and sodium. Fibre, salt, cholesterol, vitamins and minerals are shown when declared but are not assumed to be required on every label. %RDA/% contribution is preserved exactly as printed for the stated serving.',
  nutrition: {
    required: [
      'energy',
      'total_carbohydrate',
      'total_sugars',
      'added_sugars',
      'protein',
      'total_fat',
      'saturated_fat',
      'trans_fat',
      'sodium',
    ],
    optional: [
      'dietary_fibre',
      'salt',
      'cholesterol',
      'vitamin_d',
      'calcium',
      'iron',
      'potassium',
      'vitamin_a',
      'vitamin_c',
      'vitamin_b12',
      'magnesium',
      'zinc',
    ],
    percentLabel: '% RDA/serve',
  },
};

export const INGREDIENT_PURPOSES = [
  { names: ['sugar', 'sucrose'], explanation: 'A sweetening carbohydrate.', purpose: 'Sweetener, bulk and browning.' },
  { names: ['glucose syrup', 'corn syrup', 'invert sugar'], explanation: 'A concentrated sugar syrup.', purpose: 'Sweetness, texture and moisture control.' },
  { names: ['wheat flour', 'maida', 'refined wheat flour', 'flour'], explanation: 'Milled cereal flour, usually providing starch and gluten when made from wheat.', purpose: 'Structure, bulk and texture.' },
  { names: ['rice flour'], explanation: 'Flour milled from rice.', purpose: 'Starch, bulk and texture.' },
  { names: ['cocoa powder'], explanation: 'Cocoa solids from processed cocoa beans.', purpose: 'Chocolate flavour and colour.' },
  { names: ['cocoa butter'], explanation: 'The fat naturally present in cocoa beans.', purpose: 'Fat, mouthfeel and chocolate texture.' },
  { names: ['vegetable oil', 'edible vegetable oil', 'sunflower oil', 'refined sunflower oil', 'canola oil', 'rapeseed oil'], explanation: 'A plant-derived edible oil; refining changes processing and flavour characteristics.', purpose: 'Fat, cooking medium and mouthfeel.' },
  { names: ['palm oil', 'palmolein'], explanation: 'Oil or fraction obtained from oil palm fruit.', purpose: 'Fat, texture and stability.' },
  { names: ['milk', 'milk solids', 'skimmed milk powder', 'milk powder'], explanation: 'A milk-derived ingredient.', purpose: 'Dairy flavour, protein, solids and texture.' },
  { names: ['salt', 'sodium chloride'], explanation: 'Sodium chloride.', purpose: 'Saltiness, flavour and preservation support.' },
  { names: ['soy lecithin', 'soya lecithin', 'lecithin'], explanation: 'A phospholipid emulsifier; the soy source is explicit when named.', purpose: 'Helps oil and water mix and improves processing.' },
  { names: ['emulsifier'], explanation: 'A food additive that helps otherwise immiscible ingredients stay mixed.', purpose: 'Emulsion stability and texture.' },
  { names: ['thickener', 'thickeners'], explanation: 'A food additive that increases viscosity or helps maintain texture.', purpose: 'Thickening, suspension and texture.' },
  { names: ['citric acid'], explanation: 'An organic acid found naturally in citrus and also manufactured for foods.', purpose: 'Acidity regulation and flavour.' },
  { names: ['tartaric acid'], explanation: 'An organic acid used in food formulations.', purpose: 'Acidity regulation and leavening support.' },
  { names: ['raising agent', 'baking powder', 'sodium bicarbonate'], explanation: 'An ingredient or blend that releases gas during baking.', purpose: 'Leavening and lighter texture.' },
  { names: ['natural flavour', 'natural flavouring'], explanation: 'A flavouring preparation described by the label as natural.', purpose: 'Flavour; the exact composition may require manufacturer information.' },
  { names: ['mustard', 'mustard powder'], explanation: 'Mustard seed or mustard preparation.', purpose: 'Flavour and seasoning; it is a declared allergen requiring attention.' },
  { names: ['lemon juice'], explanation: 'Juice from lemon fruit.', purpose: 'Acidity and flavour.' },
  { names: ['preservative', 'preservatives'], explanation: 'A food additive used to slow spoilage or microbial growth.', purpose: 'Shelf-life and preservation.' },
  { names: ['antioxidant'], explanation: 'A food additive that helps slow oxidation.', purpose: 'Protects flavour, colour or fat stability.' },
  { names: ['artificial flavour', 'nature identical flavour'], explanation: 'A declared flavouring preparation.', purpose: 'Flavour; the exact composition may require manufacturer information.' },
  { names: ['peanut', 'groundnut'], explanation: 'A legume seed used as an ingredient.', purpose: 'Flavour, protein, fat and texture.' },
  { names: ['sesame', 'sesame seed', 'til', 'tahini'], explanation: 'Sesame seed or a sesame preparation.', purpose: 'Flavour, fat and texture.' },
  { names: ['maltodextrin'], explanation: 'A starch-derived carbohydrate polymer.', purpose: 'Bulk, texture and carrier for flavours or other ingredients.' },
  { names: ['starch', 'modified starch'], explanation: 'A plant-derived carbohydrate; modification changes its functional properties.', purpose: 'Thickening, binding and texture.' },
];
