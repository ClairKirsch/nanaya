import { swaggerSpec } from '../src/swagger.js';
import fs from 'fs';

fs.writeFileSync('openapi.json', JSON.stringify(swaggerSpec, null, 2));
console.log('✓ Generated openapi.json');
