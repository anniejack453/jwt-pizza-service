const express = require("express");
const config = require("../config.js");
const { Role, DB } = require("../database/database.js");
const { authRouter } = require("./authRouter.js");
const { asyncHandler, StatusCodeError } = require("../endpointHelper.js");
const metrics = require("../metrics.js");
const logger = require("../logger.js");

const orderRouter = express.Router();

function validateOrderPayload(orderPayload) {
  if (!orderPayload || typeof orderPayload !== "object") {
    throw new StatusCodeError("invalid order payload", 400);
  }

  const { franchiseId, storeId, items } = orderPayload;
  if (!Number.isInteger(franchiseId) || franchiseId <= 0) {
    throw new StatusCodeError("invalid franchiseId", 400);
  }
  if (!Number.isInteger(storeId) || storeId <= 0) {
    throw new StatusCodeError("invalid storeId", 400);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new StatusCodeError("order must include at least one item", 400);
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new StatusCodeError("invalid order item", 400);
    }
    if (!Number.isInteger(item.menuId) || item.menuId <= 0) {
      throw new StatusCodeError("invalid order item menuId", 400);
    }
    if (
      item.description !== undefined &&
      typeof item.description !== "string"
    ) {
      throw new StatusCodeError("invalid order item description", 400);
    }
    if (
      item.price !== undefined &&
      (!Number.isFinite(Number(item.price)) || Number(item.price) <= 0)
    ) {
      throw new StatusCodeError("invalid order item price", 400);
    }
  }
}

orderRouter.docs = [
  {
    method: "GET",
    path: "/api/order/menu",
    description: "Get the pizza menu",
    example: `curl localhost:3000/api/order/menu`,
    response: [
      {
        id: 1,
        title: "Veggie",
        image: "pizza1.png",
        price: 0.0038,
        description: "A garden of delight",
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/order/menu",
    requiresAuth: true,
    description: "Add an item to the menu",
    example: `curl -X PUT localhost:3000/api/order/menu -H 'Content-Type: application/json' -d '{ "title":"Student", "description": "No topping, no sauce, just carbs", "image":"pizza9.png", "price": 0.0001 }'  -H 'Authorization: Bearer tttttt'`,
    response: [
      {
        id: 1,
        title: "Student",
        description: "No topping, no sauce, just carbs",
        image: "pizza9.png",
        price: 0.0001,
      },
    ],
  },
  {
    method: "GET",
    path: "/api/order",
    requiresAuth: true,
    description: "Get the orders for the authenticated user",
    example: `curl -X GET localhost:3000/api/order  -H 'Authorization: Bearer tttttt'`,
    response: {
      dinerId: 4,
      orders: [
        {
          id: 1,
          franchiseId: 1,
          storeId: 1,
          date: "2024-06-05T05:14:40.000Z",
          items: [{ id: 1, menuId: 1, description: "Veggie", price: 0.05 }],
        },
      ],
      page: 1,
    },
  },
  {
    method: "POST",
    path: "/api/order",
    requiresAuth: true,
    description: "Create a order for the authenticated user",
    example: `curl -X POST localhost:3000/api/order -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}'  -H 'Authorization: Bearer tttttt'`,
    response: {
      order: {
        franchiseId: 1,
        storeId: 1,
        items: [{ menuId: 1, description: "Veggie", price: 0.05 }],
        id: 1,
      },
      jwt: "1111111111",
    },
  },
];

// getMenu
orderRouter.get(
  "/menu",
  asyncHandler(async (req, res) => {
    res.send(await DB.getMenu());
  }),
);

// addMenuItem
orderRouter.put(
  "/menu",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError("unable to add menu item", 403);
    }

    const addMenuItemReq = req.body;
    await DB.addMenuItem(addMenuItemReq);
    res.send(await DB.getMenu());
  }),
);

// getOrders
orderRouter.get(
  "/",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json(await DB.getOrders(req.user, page));
  }),
);

// createOrder
orderRouter.post(
  "/",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const getOrderPizzaCount = (orderPayload) =>
      Array.isArray(orderPayload?.items) ? orderPayload.items.length : 0;
    const getOrderRevenue = (orderPayload) =>
      (Array.isArray(orderPayload?.items) ? orderPayload.items : []).reduce(
        (sum, item) => sum + Number(item?.price || 0),
        0,
      );

    try {
      const orderReq = req.body;
      validateOrderPayload(orderReq);
      const order = await DB.addDinerOrder(req.user, orderReq);
      const pizzaCount = getOrderPizzaCount(order);
      const revenue = getOrderRevenue(order);
      const factoryRequestBody = {
        diner: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
        },
        order,
      };

      logger.log("info", "factory", {
        path: `${config.factory.url}/api/order`,
        requestBody: factoryRequestBody,
      });

      const r = await fetch(`${config.factory.url}/api/order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${config.factory.apiKey}`,
        },
        body: JSON.stringify(factoryRequestBody),
      });
      const j = await r.json();

      logger.log(r.ok ? "info" : "warn", "factory", {
        path: `${config.factory.url}/api/order`,
        statusCode: r.status,
        responseBody: j,
      });

      if (r.ok) {
        metrics.pizzaPurchase(
          "success",
          Date.now() - startTime,
          revenue,
          pizzaCount,
        );
        res.send({ order, followLinkToEndChaos: j.reportUrl, jwt: j.jwt });
      } else {
        metrics.pizzaPurchase("failure", Date.now() - startTime, 0, 0);
        res.status(500).send({
          message: "Failed to fulfill order at factory",
          followLinkToEndChaos: j.reportUrl,
        });
      }
    } catch (error) {
      metrics.pizzaPurchase("failure", Date.now() - startTime, 0, 0);
      throw error;
    }
  }),
);

module.exports = orderRouter;
