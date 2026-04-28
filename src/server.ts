import { app } from "./app";
import { env } from "./env";

app.listen(env.PORT, () => {
  console.log(`kowope_be listening on http://localhost:${env.PORT}`);
});

