require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const app = express();
const port = 3000;

// Установка часового пояса
process.env.TZ = 'Asia/Almaty';

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const managerChatId = process.env.MANAGER_CHAT_ID;

// MongoDB подключение
mongoose.connect('mongodb://localhost/cleaning_app', { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

// Схемы
const employeeSchema = new mongoose.Schema({
    name: String,
    telegramId: String
});
const managerSchema = new mongoose.Schema({
    username: String,
    password: String,
    name: String,
    isAdmin: Boolean
});
const orderSchema = new mongoose.Schema({
    clientName: String,
    clientPhone: String,
    address: String,
    description: String,
    dateTime: Date,
    price: Number,
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    manager: String,
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' }
});
const taskSchema = new mongoose.Schema({
    text: String,
    status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
    manager: String,
    date: Date,
    createdBy: String
});
const Employee = mongoose.model('Employee', employeeSchema);
const Manager = mongoose.model('Manager', managerSchema);
const Order = mongoose.model('Order', orderSchema);
const Task = mongoose.model('Task', taskSchema);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Middleware для проверки JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.error('No token provided');
        return res.status(401).json({ message: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
        console.log('Token verified:', decoded);
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Token verification failed:', error);
        res.status(403).json({ message: 'Invalid token' });
    }
}

// Middleware для проверки админа
const authenticateAdmin = (req, res, next) => {
    console.log('Checking admin:', req.user);
    if (!req.user.isAdmin) {
        console.log('User is not admin:', req.user);
        return res.status(403).send('Доступ только для админа');
    }
    next();
};

// Telegram Bot: Обработка /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const employee = await Employee.findOne({ telegramId: chatId.toString() });
        if (!employee) {
            bot.sendMessage(chatId, 'Вы не зарегистрированы как исполнитель. Обратитесь к администратору.');
            return;
        }
        bot.sendMessage(chatId, `Привет, ${employee.name}! Нажми ниже, чтобы увидеть заказы на сегодня.`, {
            reply_markup: {
                inline_keyboard: [[{ text: 'Показать заказы', callback_data: 'show_orders' }]]
            }
        });
    } catch (error) {
        console.error('Error in /start:', error);
        bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте позже.');
    }
});

// Telegram Bot: Обработка кнопок
bot.on('callback_query', async (query) => {
    if (!query.message) {
        console.warn('Callback query without message:', query);
        bot.answerCallbackQuery(query.id, { text: 'Ошибка: сообщение недоступно.' });
        return;
    }

    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        const employee = await Employee.findOne({ telegramId: chatId.toString() });
        if (!employee) {
            bot.sendMessage(chatId, 'Вы не зарегистрированы как исполнитель.');
            bot.answerCallbackQuery(query.id);
            return;
        }

        if (data === 'show_orders') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);

            console.log('Searching orders for employee:', employee._id, 'Date range:', today, tomorrow);

            const orders = await Order.find({
                employee: employee._id,
                dateTime: { $gte: today, $lt: tomorrow },
                status: 'pending'
            }).populate('employee');

            console.log('Found orders:', orders.length, orders.map(o => ({ id: o._id, dateTime: o.dateTime, status: o.status })));

            if (orders.length === 0) {
                bot.sendMessage(chatId, 'На сегодня нет актуальных заказов.');
                bot.answerCallbackQuery(query.id);
                return;
            }

            const buttons = orders.map(order => [{
                text: `${new Date(order.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} - ${order.clientName}`,
                callback_data: `order_${order._id}`
            }]);

            await bot.sendMessage(chatId, 'Актуальные заказы на сегодня:', {
                reply_markup: { inline_keyboard: buttons }
            });
            bot.answerCallbackQuery(query.id);
        } else if (data.startsWith('order_')) {
            const orderId = data.split('_')[1];
            const order = await Order.findById(orderId).populate('employee');
            if (!order) {
                bot.sendMessage(chatId, 'Заказ не найден.');
                bot.answerCallbackQuery(query.id);
                return;
            }

            const message = `
📋 *Детали заказа*:
• Клиент: 👤 ${order.clientName}
• Телефон: 📞 ${order.clientPhone}
• Адрес: 🏠 ${order.address}
• Описание: 📝 ${order.description}
• Дата и время: 🕒 ${new Date(order.dateTime).toLocaleString('ru-RU')}
• Цена: 💰 ${order.price} ₽
• Исполнитель: 👷 ${order.employee.name}
• Статус: ${order.status === 'pending' ? 'Ожидает' : 'Завершён'}
            `;
            const keyboard = order.status === 'pending' ? {
                inline_keyboard: [[{ text: 'Подтвердить выполнение', callback_data: `complete_${order._id}` }]]
            } : {};
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
            bot.answerCallbackQuery(query.id);
        } else if (data.startsWith('complete_')) {
            const orderId = data.split('_')[1];
            const order = await Order.findByIdAndUpdate(orderId, { status: 'completed' }, { new: true }).populate('employee');
            if (!order) {
                bot.sendMessage(chatId, 'Заказ не найден.');
                bot.answerCallbackQuery(query.id);
                return;
            }
            await bot.sendMessage(chatId, 'Заказ завершён!');
            await bot.sendMessage(managerChatId, `Заказ #${order._id} завершён исполнителем ${employee.name}.`);
            bot.answerCallbackQuery(query.id);
        }
    } catch (error) {
        console.error('Error in callback_query:', error);
        bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте позже.');
        bot.answerCallbackQuery(query.id);
    }
});

// Напоминания за час до заказа
async function checkUpcomingOrders() {
    try {
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 61 * 60 * 1000);
        const inOneHourMinusOne = new Date(now.getTime() + 60 * 60 * 1000);

        const orders = await Order.find({
            dateTime: { $gte: inOneHourMinusOne, $lte: inOneHour },
            status: 'pending'
        }).populate('employee');

        for (const order of orders) {
            if (order.employee && order.employee.telegramId) {
                const message = `
⏰ *Напоминание о заказе*:
• Клиент: 👤 ${order.clientName}
• Телефон: 📞 ${order.clientPhone}
• Адрес: 🏠 ${order.address}
• Описание: 📝 ${order.description}
• Время: 🕒 ${new Date(order.dateTime).toLocaleString('ru-RU')}
• Цена: 💰 ${order.price} ₽
                `;
                await bot.sendMessage(order.employee.telegramId, message, { parse_mode: 'Markdown' });
                console.log(`Reminder sent for order ${order._id} to ${order.employee.name}`);
            }
        }
    } catch (error) {
        console.error('Error in checkUpcomingOrders:', error);
    }
}

// Запуск проверки каждую минуту
setInterval(checkUpcomingOrders, 60 * 1000);

// Проверка токена
app.get('/api/verify-token', authenticateToken, (req, res) => {
    console.log('Verify token response:', { isAdmin: req.user.isAdmin });
    res.json({ isAdmin: req.user.isAdmin });
});

// Авторизация
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    console.log('Login attempt:', { username });
    try {
        const manager = await Manager.findOne({ username });
        if (!manager) {
            console.log('Manager not found:', username);
            return res.status(401).json({ message: 'Неверный логин или пароль' });
        }
        if (!await bcrypt.compare(password, manager.password)) {
            console.log('Invalid password for:', username);
            return res.status(401).json({ message: 'Неверный логин или пароль' });
        }
        const token = jwt.sign({ username, name: manager.name, isAdmin: manager.isAdmin }, process.env.JWT_SECRET, { expiresIn: '1h' });
        console.log('Login successful:', { username, isAdmin: manager.isAdmin });
        res.json({ token, managerName: manager.name, isAdmin: manager.isAdmin });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Получение списка сотрудников
app.get('/api/employees', authenticateToken, async (req, res) => {
    try {
        const employees = await Employee.find();
        res.json(employees);
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Получение списка сотрудников для админа
app.get('/api/admin/employees', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const employees = await Employee.find();
        res.json(employees);
    } catch (error) {
        console.error('Error fetching admin employees:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Создание сотрудника
app.post('/api/admin/employees', authenticateToken, authenticateAdmin, async (req, res) => {
    const { name, telegramId } = req.body;
    if (!name || !telegramId) {
        return res.status(400).send('Недостаточно данных');
    }
    const employee = new Employee({ name, telegramId });
    try {
        await employee.save();
        res.status(200).send('Исполнитель добавлен');
    } catch (error) {
        console.error('Error creating employee:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Редактирование сотрудника
app.put('/api/admin/employees/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    const { name, telegramId } = req.body;
    try {
        const employee = await Employee.findById(req.params.id);
        if (!employee) return res.status(404).send('Исполнитель не найден');
        if (name) employee.name = name;
        if (telegramId) employee.telegramId = telegramId;
        await employee.save();
        res.status(200).send('Исполнитель обновлен');
    } catch (error) {
        console.error('Error updating employee:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Удаление сотрудника
app.delete('/api/admin/employees/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const employee = await Employee.findById(req.params.id);
        if (!employee) return res.status(404).send('Исполнитель не найден');
        await Employee.deleteOne({ _id: req.params.id });
        res.status(200).send('Исполнитель удален');
    } catch (error) {
        console.error('Error deleting employee:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Создание заказа
app.post('/api/orders', authenticateToken, async (req, res) => {
    const { clientName, clientPhone, address, description, dateTime, price, employee, manager } = req.body;
    console.log('Creating order:', req.body);

    if (!clientName || !clientPhone || !address || !description || !dateTime || !price || !employee) {
        return res.status(400).send('Недостаточно данных');
    }

    if (!req.user.isAdmin && new Date(dateTime) < new Date()) {
        return res.status(400).send('Нельзя создавать заказы с датой в прошлом');
    }

    const order = new Order({
        clientName,
        clientPhone,
        address,
        description,
        dateTime: new Date(dateTime),
        price,
        employee,
        manager: manager || req.user.name,
        status: 'pending'
    });

    try {
        await order.save();
        const employeeData = await Employee.findById(employee);
        if (!employeeData) {
            return res.status(404).send('Исполнитель не найден');
        }
        const message = `Новый заказ:\nКлиент: ${clientName}\nТелефон: ${clientPhone}\nАдрес: ${address}\nОписание: ${description}\nДата и время: ${dateTime}\nЦена: ${price}₽\nИсполнитель: ${employeeData.name}\nМенеджер: ${order.manager}`;
        try {
            await bot.sendMessage(managerChatId, message);
        } catch (telegramError) {
            console.error('Telegram error:', telegramError);
        }
        res.status(200).send('Заказ отправлен');
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Обновление заказа
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
    const { clientName, clientPhone, address, description, dateTime, price, employee, manager } = req.body;
    console.log('Updating order:', req.body);

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid order ID:', req.params.id);
            return res.status(400).send('Недопустимый ID заказа');
        }
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send('Заказ не найден');

        if (!req.user.isAdmin && new Date(order.dateTime) < new Date()) {
            return res.status(400).send('Нельзя редактировать выполненные заказы');
        }

        if (!req.user.isAdmin && new Date(dateTime) < new Date()) {
            return res.status(400).send('Нельзя установить дату в прошлом');
        }

        order.clientName = clientName;
        order.clientPhone = clientPhone;
        order.address = address;
        order.description = description;
        order.dateTime = new Date(dateTime);
        order.price = price;
        order.employee = employee;
        order.manager = manager || req.user.name;

        await order.save();
        const employeeData = await Employee.findById(employee);
        if (!employeeData) {
            return res.status(404).send('Исполнитель не найден');
        }
        const message = `Обновленный заказ:\nКлиент: ${clientName}\nТелефон: ${clientPhone}\nАдрес: ${address}\nОписание: ${description}\nДата и время: ${dateTime}\nЦена: ${price}₽\nИсполнитель: ${employeeData.name}\nМенеджер: ${order.manager}`;
        try {
            await bot.sendMessage(managerChatId, message);
        } catch (telegramError) {
            console.error('Telegram error:', telegramError);
        }
        res.status(200).send('Заказ обновлен');
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Удаление заказа
app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid order ID:', req.params.id);
            return res.status(400).send('Недопустимый ID заказа');
        }
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send('Заказ не найден');

        if (!req.user.isAdmin && new Date(order.dateTime) < new Date()) {
            return res.status(400).send('Нельзя удалять выполненные заказы');
        }

        const employeeData = await Employee.findById(order.employee);
        if (!employeeData) {
            return res.status(404).send('Исполнитель не найден');
        }

        await Order.deleteOne({ _id: req.params.id });
        const message = `Заказ удален:\nКлиент: ${order.clientName}\nТелефон: ${order.clientPhone}\nАдрес: ${order.address}\nМенеджер: ${order.manager}`;
        try {
            await bot.sendMessage(managerChatId, message);
        } catch (telegramError) {
            console.error('Telegram error:', telegramError);
        }
        res.status(200).send('Заказ удален');
    } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Получение заказов менеджера
app.get('/api/orders/manager', authenticateToken, async (req, res) => {
    try {
        if (!req.user || !req.user.name) {
            console.error('Invalid user data in token:', req.user);
            return res.status(401).json({ message: 'Invalid or missing manager name in token' });
        }
        console.log('Fetching orders for manager:', req.user.name);
        const orders = await Order.find({ manager: req.user.name }).populate({
            path: 'employee',
            select: 'name',
            options: { lean: true }
        }).lean();
        console.log('Found orders:', orders.length, orders);
        if (!orders.length) {
            console.warn('No orders found for manager:', req.user.name);
        }
        res.json(orders);
    } catch (error) {
        console.error('Error fetching manager orders:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Получение конкретного заказа
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid order ID:', req.params.id);
            return res.status(400).send('Недопустимый ID заказа');
        }
        const order = await Order.findById(req.params.id).populate('employee').lean();
        if (!order) return res.status(404).send('Заказ не найден');
        console.log('Order found:', order);
        res.json(order);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Получение заказов для календаря
app.get('/api/orders', authenticateToken, async (req, res) => {
    const { employee } = req.query;
    try {
        const query = employee ? { employee } : {};
        const orders = await Order.find(query).populate('employee');
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Получение заказов для админ-панели
app.get('/api/admin/orders', authenticateToken, authenticateAdmin, async (req, res) => {
    const { sort, employee, date, search } = req.query;
    let query = {};

    if (employee) {
        if (!mongoose.Types.ObjectId.isValid(employee)) {
            console.error('Invalid employee ID:', employee);
            return res.status(400).send('Недопустимый ID сотрудника');
        }
        query.employee = employee;
    }

    if (date && !search) {
        const startDate = new Date(date);
        const endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 1);
        query.dateTime = {
            $gte: startDate,
            $lt: endDate
        };
    }

    if (search) {
        query.$or = [
            { clientName: { $regex: search, $options: 'i' } },
            { clientPhone: { $regex: search, $options: 'i' } },
            { address: { $regex: search, $options: 'i' } }
        ];
    }

    try {
        const orders = await Order.find(query).populate('employee').sort(sort ? { [sort]: 1 } : {});
        res.json(orders);
    } catch (error) {
        console.error('Error fetching admin orders:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Получение списка менеджеров
app.get('/api/admin/managers', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const managers = await Manager.find({ isAdmin: false });
        res.json(managers);
    } catch (error) {
        console.error('Error fetching managers:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Регистрация менеджера
app.post('/api/admin/managers', authenticateToken, authenticateAdmin, async (req, res) => {
    const { username, password, name } = req.body;
    try {
        if (!username || !password || !name) {
            return res.status(400).send('Недостаточно данных');
        }
        const existingManager = await Manager.findOne({ username });
        if (existingManager) {
            return res.status(400).send('Менеджер с таким логином уже существует');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const manager = new Manager({
            username,
            password: hashedPassword,
            name,
            isAdmin: false
        });
        await manager.save();
        res.status(201).send('Менеджер создан');
    } catch (error) {
        console.error('Error creating manager:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Редактирование менеджера
app.put('/api/admin/managers/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    const { username, password, name } = req.body;
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid manager ID:', req.params.id);
            return res.status(400).send('Недопустимый ID менеджера');
        }
        const manager = await Manager.findById(req.params.id);
        if (!manager) return res.status(404).send('Менеджер не найден');
        if (manager.username === req.user.username) return res.status(403).send('Нельзя редактировать самого себя');

        if (username) manager.username = username;
        if (password) manager.password = await bcrypt.hash(password, 10);
        if (name) manager.name = name;

        await manager.save();
        res.status(200).send('Менеджер обновлен');
    } catch (error) {
        console.error('Error updating manager:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// Удаление менеджера
app.delete('/api/admin/managers/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid manager ID:', req.params.id);
            return res.status(400).send('Недопустимый ID менеджера');
        }
        const manager = await Manager.findById(req.params.id);
        if (!manager) return res.status(404).send('Менеджер не найден');
        if (manager.username === req.user.username) return res.status(403).send('Нельзя удалить самого себя');
        await Manager.deleteOne({ _id: req.params.id });
        res.status(200).send('Менеджер удален');
    } catch (error) {
        console.error('Error deleting manager:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Создание задачи
app.post('/api/tasks', authenticateToken, async (req, res) => {
    const { text, date } = req.body;
    try {
        if (!text || !date) {
            return res.status(400).send('Недостаточно данных');
        }
        const task = new Task({
            text,
            status: 'pending',
            manager: req.user.name,
            date: new Date(date),
            createdBy: req.user.name
        });
        await task.save();
        res.status(200).send('Задача создана');
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Обновление задачи
app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
    const { text, status, date } = req.body;
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid task ID:', req.params.id);
            return res.status(400).send('Недопустимый ID задачи');
        }
        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).send('Задача не найдена');
        if (task.manager !== req.user.name && !req.user.isAdmin) {
            return res.status(403).send('Нет доступа к задаче');
        }

        if (text) task.text = text;
        if (status) {
            const oldStatus = task.status;
            task.status = status;
            if (status === 'in_progress' && oldStatus !== 'in_progress') {
                await bot.sendMessage(managerChatId, `Менеджер ${task.manager} начал выполнять задачу: ${task.text}`);
            } else if (status === 'completed' && oldStatus !== 'completed') {
                await bot.sendMessage(managerChatId, `Менеджер ${task.manager} завершил задачу: ${task.text}`);
            }
        }
        if (date) task.date = new Date(date);
        await task.save();
        res.status(200).send('Задача обновлена');
    } catch (error) {
        console.error('Error updating task:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Получение задач менеджера
app.get('/api/tasks', authenticateToken, async (req, res) => {
    const { date } = req.query;
    try {
        let query = { manager: req.user.name };
        if (date) {
            const startDate = new Date(date);
            const endDate = new Date(date);
            endDate.setDate(endDate.getDate() + 1);
            query.date = { $gte: startDate, $lt: endDate };
        }
        const tasks = await Task.find(query).sort({ date: 1 });
        res.json(tasks);
    } catch (error) {
        console.error('Error fetching tasks:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Получение задач для админа
app.get('/api/admin/tasks', authenticateToken, authenticateAdmin, async (req, res) => {
    const { manager, date } = req.query;
    let query = {};
    if (manager) query.manager = manager;
    if (date) {
        const startDate = new Date(date);
        const endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 1);
        query.date = { $gte: startDate, $lt: endDate };
    }
    try {
        const tasks = await Task.find(query).sort({ date: 1 });
        res.json(tasks);
    } catch (error) {
        console.error('Error fetching admin tasks:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Создание задачи админом
app.post('/api/admin/tasks', authenticateToken, authenticateAdmin, async (req, res) => {
    const { text, manager, date } = req.body;
    if (!text || !manager || !date) {
        return res.status(400).send('Недостаточно данных');
    }
    const task = new Task({
        text,
        status: 'pending',
        manager,
        date: new Date(date),
        createdBy: req.user.name
    });
    try {
        await task.save();
        res.status(200).send('Задача создана');
    } catch (error) {
        console.error('Error creating admin task:', error);
        res.status(500).send('Ошибка сервера');
    }
});

// API для задач: Удаление задачи админом
app.delete('/api/admin/tasks/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            console.error('Invalid task ID:', req.params.id);
            return res.status(400).send('Недопустимый ID задачи');
        }
        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).send('Задача не найдена');
        await Task.deleteOne({ _id: req.params.id });
        res.status(200).send('Задача удалена');
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).send('Ошибка сервера');
    }
});

app.listen(port, () => {
    console.log(`Сервер работает на http://localhost:${port}`);
    console.log('Server time:', new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }));
    checkUpcomingOrders();
});