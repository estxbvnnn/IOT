import fs from 'node:fs'
import path from 'node:path'

// Las pruebas de base de datos usan el MISMO rol que la aplicación (iot_app) para validar también los permisos.
const file = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(file)) process.loadEnvFile(file)
