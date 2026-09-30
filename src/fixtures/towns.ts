export type Town = { key: string; name: string; zips: string[]; lat: number; lng: number; area: string; weight: number };

/** Orte mit ungefähren Mittelpunkten (Mock-Geodaten, nicht für Navigation gedacht). */
export const TOWNS: Town[] = [
  { key: 'voelklingen', name: 'Völklingen', zips: ['66333'], lat: 49.2514, lng: 6.8447, area: '06898', weight: 3 },
  { key: 'saarbruecken', name: 'Saarbrücken', zips: ['66111', '66113', '66115', '66117', '66119', '66121', '66123', '66125', '66126', '66127', '66128', '66129', '66130', '66131', '66132', '66133'], lat: 49.2402, lng: 6.9969, area: '0681', weight: 10 },
  { key: 'puettlingen', name: 'Püttlingen', zips: ['66346'], lat: 49.2858, lng: 6.8889, area: '06898', weight: 1.6 },
  { key: 'saarlouis', name: 'Saarlouis', zips: ['66740'], lat: 49.3136, lng: 6.7519, area: '06831', weight: 3 },
  { key: 'dillingen', name: 'Dillingen/Saar', zips: ['66763'], lat: 49.3533, lng: 6.7275, area: '06831', weight: 1.6 },
  { key: 'wadgassen', name: 'Wadgassen', zips: ['66787'], lat: 49.2686, lng: 6.7889, area: '06834', weight: 1.1 },
  { key: 'sulzbach', name: 'Sulzbach/Saar', zips: ['66280'], lat: 49.2989, lng: 7.0614, area: '06897', weight: 1.5 },
  { key: 'heusweiler', name: 'Heusweiler', zips: ['66265'], lat: 49.3594, lng: 6.9397, area: '06806', weight: 1.2 },
  { key: 'lebach', name: 'Lebach', zips: ['66822'], lat: 49.4117, lng: 6.9119, area: '06881', weight: 1.2 },
  { key: 'neunkirchen', name: 'Neunkirchen/Saar', zips: ['66538'], lat: 49.3447, lng: 7.18, area: '06821', weight: 3 },
  { key: 'stingbert', name: 'St. Ingbert', zips: ['66386'], lat: 49.2745, lng: 7.1117, area: '06894', weight: 2.5 },
  { key: 'homburg', name: 'Homburg/Saar', zips: ['66424'], lat: 49.3267, lng: 7.3386, area: '06841', weight: 3 },
  { key: 'merzig', name: 'Merzig', zips: ['66663'], lat: 49.4436, lng: 6.6364, area: '06861', weight: 2 },
  { key: 'zweibruecken', name: 'Zweibrücken', zips: ['66482'], lat: 49.2492, lng: 7.369, area: '06332', weight: 2.5 },
  { key: 'kaiserslautern', name: 'Kaiserslautern', zips: ['67655', '67657', '67659'], lat: 49.4401, lng: 7.7491, area: '0631', weight: 6 },
  { key: 'trier', name: 'Trier', zips: ['54290', '54292', '54293'], lat: 49.7596, lng: 6.6441, area: '0651', weight: 6 },
];

export const STREETS = ['Hauptstraße', 'Bahnhofstraße', 'Poststraße', 'Schulstraße', 'Gartenstraße', 'Kirchstraße', 'Ludwigstraße', 'Rathausstraße', 'Bergstraße', 'Marktstraße', 'Lindenstraße', 'Wilhelmstraße', 'Am Markt', 'Industriestraße', 'Talstraße'];
