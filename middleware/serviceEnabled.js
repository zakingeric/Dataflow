const serviceEnabled = (serviceName) => {
  return (req, res, next) => {
    next();
  };
};

module.exports = { serviceEnabled };
