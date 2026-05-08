const serviceEnabled = (serviceName) => {
  return async (req, res, next) => {
    next();
  };
};

module.exports = { serviceEnabled };
