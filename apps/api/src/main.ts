import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { DomainExceptionFilter } from './common/zod-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('Fuel Supply Intelligence & Resilience Platform')
    .setDescription(
      'Operates on the BUP Fuel Supply Simulator (simulated data only).\n\n' +
        '**Operator endpoints** (lock icon): call `POST /api/auth/login`, copy `token`, click **Authorize** and paste it.',
    )
    .setVersion(process.env.APP_VERSION ?? '1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'api/docs-json',
    customSiteTitle: 'Fuel Ops API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });

  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
