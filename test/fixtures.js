'use strict';

// A light-mode "browser window" with a tutorial, a recommendations sidebar,
// browser chrome and a taskbar, rendered to PNG for real OCR tests.
const TUTORIAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
  <style>
    text { font-family: Arial, Helvetica, sans-serif; fill: #111; }
    .mono { font-family: Consolas, 'Courier New', monospace; }
  </style>
  <rect width="1600" height="1000" fill="#ffffff"/>
  <rect width="1600" height="44" fill="#dfe3ea"/>
  <text x="20" y="29" font-size="16">Python Lists Tutorial X | New tab X | Inbox (3) X | Weather X |</text>
  <rect y="44" width="1600" height="44" fill="#f1f3f6"/>
  <text x="60" y="73" font-size="16">https://www.example.com/python/lists?utm_source=newsletter&amp;utm_medium=email</text>
  <text x="30" y="150" font-size="18">Home</text>
  <text x="30" y="190" font-size="18">Courses</text>
  <text x="30" y="230" font-size="18">Blog</text>
  <text x="30" y="270" font-size="18">Forum</text>
  <text x="30" y="310" font-size="18">Login</text>
  <text x="260" y="160" font-size="40" font-weight="bold">Python Lists</text>
  <text x="260" y="215" font-size="20">A list is an ordered collection of items that can be changed after it is created.</text>
  <text x="260" y="248" font-size="20">Lists are written with square brackets and items are separated by commas.</text>
  <text x="260" y="300" font-size="20">1. Create a list by assigning values inside square brackets.</text>
  <text x="260" y="333" font-size="20">2. Access an item using its index, which starts at zero.</text>
  <text x="260" y="366" font-size="20">3. Use the append method to add an item to the end of the list.</text>
  <rect x="250" y="390" width="760" height="100" fill="#f4f4f4"/>
  <text x="270" y="428" font-size="20" class="mono">fruits = ["apple", "banana", "cherry"]</text>
  <text x="270" y="465" font-size="20" class="mono">print(fruits[0])</text>
  <text x="260" y="535" font-size="20">Important: negative indexes count from the end of the list.</text>
  <text x="260" y="568" font-size="20">Read the official guide at https://docs.python.org/3/tutorial/datastructures.html</text>
  <text x="260" y="620" font-size="20">Important: negative indexes count from the end of the list.</text>
  <text x="1190" y="140" font-size="20" font-weight="bold">Recommended</text>
  <text x="1190" y="190" font-size="18">Learn Java in 10 Minutes</text>
  <text x="1190" y="215" font-size="15">1.2M views 3 days ago</text>
  <text x="1190" y="270" font-size="18">Top 10 Coding Laptops</text>
  <text x="1190" y="295" font-size="15">850K views 2 weeks ago</text>
  <text x="1190" y="350" font-size="18">Free Cloud Hosting Trial</text>
  <text x="1190" y="375" font-size="15">Sponsored</text>
  <rect y="952" width="1600" height="48" fill="#e8ebf0"/>
  <text x="560" y="983" font-size="16">Search</text>
  <text x="1440" y="975" font-size="14">11:37 PM</text>
  <text x="1440" y="993" font-size="14">09-10-2026</text>
</svg>`;

module.exports = { TUTORIAL_SVG };
