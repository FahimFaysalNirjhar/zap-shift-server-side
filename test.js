const dns = require("dns");

dns.setServers(["8.8.8.8", "8.8.4.4"]);

dns.resolveSrv("_mongodb._tcp.cluster0.xrup6i8.mongodb.net", (err, records) => {
  if (err) {
    console.error(err);
    return;
  }

  console.log(records);
});
