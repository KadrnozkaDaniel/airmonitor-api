import { join } from 'node:path';
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload';
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
} from '@fastify/type-provider-zod';
import type { AuthPluginOptions } from './plugins/auth';

export interface AppOptions
  extends
    FastifyServerOptions,
    Partial<AutoloadPluginOptions>,
    AuthPluginOptions {}
// Pass --options via CLI arguments in command to enable these options.
const options: AppOptions = {};

const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts,
): Promise<void> => {
  // Zod validation requests
  fastify.setValidatorCompiler(validatorCompiler);

  //Zod serialization and validation of responses
  fastify.setSerializerCompiler(serializerCompiler);

  //Swagger - generate OpenAPI specification
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'airmonitor API',
        description: 'REST API documentation',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  //Swagger UI - web documentation
  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      operationsSorter: 'method',
    },
  });

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application

  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: opts,
  });

  // This loads all plugins defined in routes
  // define your routes in one of these

  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'routes'),
    options: opts,
  });
};

export default app;
export { app, options };
